/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename, dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { parseFrontMatter, YamlParseError } from '../../../../base/common/yaml.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import {
	IRepositoryContextSkillProjectionService,
	ISkillProjectionManifest,
	ISkillProjectionRequest,
	ISkillProjectionResult,
} from '../../../../platform/repositoryContext/common/skillProjection.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import {
	CanonicalActivation,
	createCanonicalConfiguration,
	GLOBAL_CONFIGURATION_FILE,
	ICanonicalConfiguration,
	ICanonicalConfigurationService,
	REPOSITORY_CONFIGURATION_DIRECTORY,
	REPOSITORY_CONFIGURATION_FILE,
} from '../common/canonicalConfiguration.js';
import { IRepositoryCatalogService } from '../common/repositoryCatalog.js';
import {
	GLOBAL_SKILLS_DIRECTORY,
	ICanonicalSkillDefinition,
	IContextSkillService,
	IEffectiveSkill,
	IEffectiveSkillSections,
	ISkillClientProjection,
	ISkillManagementSnapshot,
	REPOSITORY_SKILLS_DIRECTORY,
	resolveEffectiveSkills,
	SKILL_DEFINITION_FILE,
	SkillOrigin,
	SkillOverride,
} from '../common/skillManagement.js';

const emptySections = resolveEffectiveSkills([], {}, {});
const projectionManifestStorageKey = 'repositoryContext.skillProjection.manifests';

interface IStoredProjectionManifests {
	readonly version: 1;
	readonly manifests: Readonly<Record<string, ISkillProjectionManifest>>;
}

export class ContextSkillService extends Disposable implements IContextSkillService {

	declare readonly _serviceBrand: undefined;

	private refreshRequest = 0;
	private _snapshot: ISkillManagementSnapshot;
	private readonly _onDidChange = this._register(new Emitter<ISkillManagementSnapshot>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IRepositoryCatalogService private readonly repositoryCatalogService: IRepositoryCatalogService,
		@ICanonicalConfigurationService private readonly canonicalConfigurationService: ICanonicalConfigurationService,
		@IRepositoryContextSkillProjectionService private readonly projectionService: IRepositoryContextSkillProjectionService,
		@IStorageService private readonly storageService: IStorageService,
		@IPathService private readonly pathService: IPathService,
	) {
		super();
		this._snapshot = {
			activeRepository: repositoryCatalogService.activeRepository,
			globalRepository: canonicalConfigurationService.globalRepository,
			sections: emptySections,
			globalSkills: [],
			errors: [],
			loading: true,
		};

		this._register(repositoryCatalogService.onDidChange(() => void this.refresh()));
		this._register(canonicalConfigurationService.onDidChangeGlobalRepository(() => void this.refresh()));
		this._register(fileService.onDidFilesChange(event => {
			const globalRepository = this.canonicalConfigurationService.globalRepository;
			const activeRepository = this.repositoryCatalogService.activeRepository;
			const affectsGlobal = globalRepository && (
				event.affects(joinPath(globalRepository, GLOBAL_CONFIGURATION_FILE)) ||
				event.affects(joinPath(globalRepository, GLOBAL_SKILLS_DIRECTORY))
			);
			const affectsRepository = activeRepository && (
				event.affects(joinPath(activeRepository, REPOSITORY_CONFIGURATION_DIRECTORY, REPOSITORY_CONFIGURATION_FILE)) ||
				event.affects(joinPath(activeRepository, REPOSITORY_CONFIGURATION_DIRECTORY, REPOSITORY_SKILLS_DIRECTORY))
			);
			if (affectsGlobal || affectsRepository) {
				void this.refresh();
			}
		}));

		void this.refresh();
	}

	get snapshot(): ISkillManagementSnapshot {
		return this._snapshot;
	}

	async refresh(): Promise<void> {
		const request = ++this.refreshRequest;
		const activeRepository = this.repositoryCatalogService.activeRepository;
		const globalRepository = this.canonicalConfigurationService.globalRepository;
		this.updateSnapshot({
			...this._snapshot,
			activeRepository,
			globalRepository,
			loading: true,
		});

		const errors: string[] = [];
		const globalConfiguration = await this.readGlobalConfiguration(errors);
		const repositoryConfiguration = await this.readRepositoryConfiguration(activeRepository, errors);
		const [globalDefinitions, repositoryDefinitions] = await Promise.all([
			this.discoverSkills(globalRepository && joinPath(globalRepository, GLOBAL_SKILLS_DIRECTORY), 'global'),
			this.discoverSkills(
				activeRepository && joinPath(activeRepository, REPOSITORY_CONFIGURATION_DIRECTORY, REPOSITORY_SKILLS_DIRECTORY),
				'repository'
			),
		]);
		if (request !== this.refreshRequest) {
			return;
		}

		const resolvedSections = resolveEffectiveSkills(
			[...globalDefinitions, ...repositoryDefinitions],
			globalConfiguration.skills,
			repositoryConfiguration.skills
		);
		const sections = await this.resolveCodexProjections(resolvedSections, activeRepository);
		if (request !== this.refreshRequest) {
			return;
		}
		const globalSections = resolveEffectiveSkills(globalDefinitions, globalConfiguration.skills, {});
		this.updateSnapshot({
			activeRepository,
			globalRepository,
			sections,
			globalSkills: this.flattenSections(globalSections),
			errors,
			loading: false,
		});
	}

	async setRepositoryOverride(skillId: string, override: SkillOverride): Promise<void> {
		const repository = this.repositoryCatalogService.activeRepository;
		if (!repository) {
			throw new Error('Select an active repository before changing a repository Skill override.');
		}
		const configuration = await this.canonicalConfigurationService.readRepositoryConfiguration(repository);
		const skills = { ...configuration.skills };
		if (override === 'inherit') {
			delete skills[skillId];
		} else {
			skills[skillId] = { activation: override };
		}
		await this.canonicalConfigurationService.writeRepositoryConfiguration(repository, {
			...configuration,
			skills,
		});
		await this.refresh();
	}

	async setGlobalActivation(skillId: string, activation: CanonicalActivation): Promise<void> {
		const configuration = await this.canonicalConfigurationService.readGlobalConfiguration();
		if (!configuration) {
			throw new Error('Select a global configuration repository before changing a global Skill default.');
		}
		await this.canonicalConfigurationService.writeGlobalConfiguration({
			...configuration,
			skills: {
				...configuration.skills,
				[skillId]: { activation },
			},
		});
		await this.refresh();
	}

	async projectToCodex(skillId: string): Promise<void> {
		const skill = this.getSkill(skillId);
		if (skill.activation !== 'on' || skill.section === 'needsAttention') {
			throw new Error('Only an enabled, valid Skill can be projected to Codex.');
		}
		await this.runCodexProjectionOperation(skill, request => this.projectionService.project(request));
	}

	async importCodexChanges(skillId: string): Promise<void> {
		await this.runCodexProjectionOperation(
			this.getSkill(skillId),
			request => this.projectionService.importChanges(request)
		);
	}

	async restoreCodexProjection(skillId: string): Promise<void> {
		await this.runCodexProjectionOperation(
			this.getSkill(skillId),
			request => this.projectionService.restore(request)
		);
	}

	private async readGlobalConfiguration(errors: string[]): Promise<ICanonicalConfiguration> {
		try {
			return await this.canonicalConfigurationService.readGlobalConfiguration() ??
				createCanonicalConfiguration('global');
		} catch (error) {
			errors.push(this.toErrorMessage('Global configuration', error));
			return createCanonicalConfiguration('global');
		}
	}

	private async readRepositoryConfiguration(
		repository: URI | undefined,
		errors: string[],
	): Promise<ICanonicalConfiguration> {
		if (!repository) {
			return createCanonicalConfiguration('repository');
		}
		try {
			return await this.canonicalConfigurationService.readRepositoryConfiguration(repository);
		} catch (error) {
			errors.push(this.toErrorMessage('Repository configuration', error));
			return createCanonicalConfiguration('repository');
		}
	}

	private async discoverSkills(
		root: URI | undefined,
		origin: SkillOrigin,
	): Promise<ICanonicalSkillDefinition[]> {
		if (!root || !await this.fileService.exists(root)) {
			return [];
		}

		try {
			const resolved = await this.fileService.resolve(root);
			const directories = resolved.children?.filter(child => child.isDirectory) ?? [];
			const definitions = await Promise.all(directories.map(directory =>
				this.readSkillDefinition(directory.resource, origin)
			));
			return definitions.sort((left, right) => left.id.localeCompare(right.id));
		} catch (error) {
			return [{
				id: `${origin}-library`,
				name: `${origin === 'global' ? 'Global' : 'Repository'} Skill library`,
				description: '',
				origin,
				resource: root,
				issue: this.toErrorMessage('Cannot read Skill library', error),
			}];
		}
	}

	private async readSkillDefinition(directory: URI, origin: SkillOrigin): Promise<ICanonicalSkillDefinition> {
		const id = basename(directory);
		const resource = joinPath(directory, SKILL_DEFINITION_FILE);
		if (!await this.fileService.exists(resource)) {
			return {
				id,
				name: id,
				description: '',
				origin,
				resource,
				issue: `${SKILL_DEFINITION_FILE} is missing.`,
			};
		}

		try {
			const content = await this.fileService.readFile(resource);
			const parseErrors: YamlParseError[] = [];
			const frontmatter = parseFrontMatter(content.value.toString(), parseErrors);
			const name = frontmatter?.getStringValue('name')?.trim();
			const description = frontmatter?.getStringValue('description')?.trim();
			const issues = parseErrors.map(error => error.message);
			if (!name) {
				issues.push('The Skill definition requires a frontmatter name.');
			}
			if (!description) {
				issues.push('The Skill definition requires a frontmatter description.');
			}
			return {
				id,
				name: name || id,
				description: description || '',
				origin,
				resource,
				issue: issues.length > 0 ? issues.join(' ') : undefined,
			};
		} catch (error) {
			return {
				id,
				name: id,
				description: '',
				origin,
				resource,
				issue: this.toErrorMessage(`Cannot read ${SKILL_DEFINITION_FILE}`, error),
			};
		}
	}

	private flattenSections(sections: ISkillManagementSnapshot['sections']): IEffectiveSkill[] {
		return [...sections.enabled, ...sections.available, ...sections.needsAttention];
	}

	private async resolveCodexProjections(
		sections: IEffectiveSkillSections,
		activeRepository: URI | undefined,
	): Promise<IEffectiveSkillSections> {
		const resolveSection = (skills: readonly IEffectiveSkill[]) =>
			Promise.all(skills.map(skill => this.resolveCodexProjection(skill, activeRepository)));
		const [enabled, available, needsAttention] = await Promise.all([
			resolveSection(sections.enabled),
			resolveSection(sections.available),
			resolveSection(sections.needsAttention),
		]);
		return { enabled, available, needsAttention };
	}

	private async resolveCodexProjection(
		skill: IEffectiveSkill,
		activeRepository: URI | undefined,
	): Promise<IEffectiveSkill> {
		let projection: ISkillClientProjection;
		try {
			const request = this.createCodexProjectionRequest(skill, activeRepository);
			if (!request) {
				projection = {
					client: 'codex',
					state: 'unsupported',
					detail: skill.issue ?? 'The canonical Skill source is unavailable.',
				};
			} else {
				const result = await this.projectionService.inspect(request);
				projection = this.toClientProjection(result, request.target);
			}
		} catch (error) {
			projection = {
				client: 'codex',
				state: 'unsupported',
				detail: this.toErrorMessage('Cannot inspect Codex projection', error),
			};
		}
		return {
			...skill,
			projections: [projection],
		};
	}

	private createCodexProjectionRequest(
		skill: IEffectiveSkill,
		activeRepository: URI | undefined,
	): ISkillProjectionRequest | undefined {
		if (skill.section === 'needsAttention' || !skill.definitionResource || !activeRepository) {
			return undefined;
		}

		const source = dirname(skill.definitionResource);
		const targetRoot = skill.origins[0] === 'repository'
			? joinPath(activeRepository, '.agents', 'skills')
			: joinPath(this.pathService.userHome({ preferLocal: true }), '.agents', 'skills');
		const target = joinPath(targetRoot, skill.id);
		return {
			client: 'codex',
			skillId: skill.id,
			source,
			target,
			manifest: this.getProjectionManifest(target),
		};
	}

	private getSkill(skillId: string): IEffectiveSkill {
		const skill = this.flattenSections(this._snapshot.sections).find(candidate => candidate.id === skillId);
		if (!skill) {
			throw new Error(`Skill "${skillId}" is not available in the active repository.`);
		}
		return skill;
	}

	private async runCodexProjectionOperation(
		skill: IEffectiveSkill,
		operation: (request: ISkillProjectionRequest) => Promise<ISkillProjectionResult>,
	): Promise<void> {
		const request = this.createCodexProjectionRequest(skill, this.repositoryCatalogService.activeRepository);
		if (!request) {
			throw new Error(`Skill "${skill.id}" has no compatible canonical source for Codex.`);
		}
		const result = await operation(request);
		this.storeProjectionManifest(request.target, result.manifest);
		await this.refresh();
	}

	private toClientProjection(result: ISkillProjectionResult, target: URI): ISkillClientProjection {
		return {
			client: 'codex',
			state: result.state,
			mode: result.mode,
			target,
			detail: result.detail,
		};
	}

	private getProjectionManifest(target: URI): ISkillProjectionManifest | undefined {
		return this.getStoredProjectionManifests()[target.toString()];
	}

	private storeProjectionManifest(target: URI, manifest: ISkillProjectionManifest | undefined): void {
		const manifests = { ...this.getStoredProjectionManifests() };
		if (manifest) {
			manifests[target.toString()] = manifest;
		} else {
			delete manifests[target.toString()];
		}
		this.storageService.store(
			projectionManifestStorageKey,
			JSON.stringify({ version: 1, manifests } satisfies IStoredProjectionManifests),
			StorageScope.PROFILE,
			StorageTarget.MACHINE
		);
	}

	private getStoredProjectionManifests(): Readonly<Record<string, ISkillProjectionManifest>> {
		const stored = this.storageService.getObject<Partial<IStoredProjectionManifests>>(
			projectionManifestStorageKey,
			StorageScope.PROFILE
		);
		if (stored?.version !== 1 || !stored.manifests || typeof stored.manifests !== 'object') {
			return {};
		}

		const manifests: Record<string, ISkillProjectionManifest> = {};
		for (const [target, manifest] of Object.entries(stored.manifests)) {
			if (this.isProjectionManifest(manifest)) {
				manifests[target] = manifest;
			}
		}
		return manifests;
	}

	private isProjectionManifest(value: unknown): value is ISkillProjectionManifest {
		if (!value || typeof value !== 'object') {
			return false;
		}
		const candidate = value as Partial<ISkillProjectionManifest>;
		return candidate.version === 1 &&
			candidate.client === 'codex' &&
			typeof candidate.skillId === 'string' &&
			candidate.mode === 'managed-copy' &&
			typeof candidate.source === 'string' &&
			typeof candidate.target === 'string' &&
			typeof candidate.sourceHash === 'string' &&
			typeof candidate.outputHash === 'string';
	}

	private toErrorMessage(context: string, error: unknown): string {
		return `${context}: ${error instanceof Error ? error.message : String(error)}`;
	}

	private updateSnapshot(snapshot: ISkillManagementSnapshot): void {
		this._snapshot = snapshot;
		this._onDidChange.fire(snapshot);
	}
}

registerSingleton(IContextSkillService, ContextSkillService, InstantiationType.Delayed);
