/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename, dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { parse, parseFrontMatter, YamlNode, YamlParseError } from '../../../../base/common/yaml.js';
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
import { IInstalledPluginPackage } from '../../../../platform/repositoryContext/common/pluginPackage.js';
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
import { IContextPluginService } from '../common/pluginManagement.js';
import {
	GLOBAL_SKILLS_DIRECTORY,
	ICanonicalSkillDefinition,
	IContextSkillService,
	IEffectiveSkill,
	IEffectiveSkillSections,
	ISkillClientProjection,
	ISkillClientCompatibility,
	ISkillManagementSnapshot,
	REPOSITORY_SKILLS_DIRECTORY,
	resolveEffectiveSkills,
	SKILL_DEFINITION_FILE,
	SkillClient,
	SkillOrigin,
	SkillOverride,
} from '../common/skillManagement.js';

const emptySections = resolveEffectiveSkills([], {}, {});
const projectionManifestStorageKey = 'repositoryContext.skillProjection.manifests';
const projectionClients: readonly SkillClient[] = ['codex', 'claude-code', 'cursor'];
const standardFrontmatterFields = new Set([
	'name',
	'description',
	'license',
	'compatibility',
	'metadata',
	'allowed-tools',
]);
const clientUndocumentedStandardFields: Readonly<Record<SkillClient, ReadonlySet<string>>> = {
	codex: new Set(),
	'claude-code': new Set(['license', 'compatibility', 'metadata']),
	cursor: new Set(['license', 'compatibility', 'allowed-tools']),
};
const clientOverlayFields: Readonly<Record<SkillClient, ReadonlySet<string>>> = {
	codex: new Set(),
	'claude-code': new Set([
		'when_to_use',
		'argument-hint',
		'arguments',
		'disable-model-invocation',
		'user-invocable',
		'disallowed-tools',
		'model',
		'effort',
		'context',
		'agent',
		'background',
		'hooks',
		'paths',
		'shell',
	]),
	cursor: new Set(['paths', 'disable-model-invocation', 'globs']),
};

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
		@IContextPluginService private readonly pluginService: IContextPluginService,
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
		this._register(pluginService.onDidChange(() => void this.refresh()));
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
		const [globalDefinitions, repositoryDefinitions, pluginDefinitions] = await Promise.all([
			this.discoverSkills(globalRepository && joinPath(globalRepository, GLOBAL_SKILLS_DIRECTORY), 'global'),
			this.discoverSkills(
				activeRepository && joinPath(activeRepository, REPOSITORY_CONFIGURATION_DIRECTORY, REPOSITORY_SKILLS_DIRECTORY),
				'repository'
			),
			this.discoverPluginSkills(),
		]);
		if (request !== this.refreshRequest) {
			return;
		}

		const resolvedSections = resolveEffectiveSkills(
			[...globalDefinitions, ...repositoryDefinitions, ...pluginDefinitions],
			globalConfiguration.skills,
			repositoryConfiguration.skills
		);
		const sections = await this.resolveClientProjections(resolvedSections, activeRepository);
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

	async project(skillId: string, client: SkillClient): Promise<void> {
		const skill = this.getSkill(skillId);
		if (skill.activation !== 'on' || skill.section === 'needsAttention') {
			throw new Error('Only an enabled, valid Skill can be projected.');
		}
		await this.runProjectionOperation(skill, client, request => this.projectionService.project(request));
	}

	async importChanges(skillId: string, client: SkillClient): Promise<void> {
		await this.runProjectionOperation(
			this.getSkill(skillId),
			client,
			request => this.projectionService.importChanges(request)
		);
	}

	async restoreProjection(skillId: string, client: SkillClient): Promise<void> {
		await this.runProjectionOperation(
			this.getSkill(skillId),
			client,
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

	private async discoverPluginSkills(): Promise<ICanonicalSkillDefinition[]> {
		const definitions = await Promise.all(this.pluginService.snapshot.installed.flatMap(plugin =>
			plugin.manifest.skills.map(skill =>
				this.readSkillDefinition(joinPath(plugin.resource, skill), 'plugin', plugin)
			)
		));
		return definitions.sort((left, right) => left.id.localeCompare(right.id));
	}

	private async readSkillDefinition(
		directory: URI,
		origin: SkillOrigin,
		plugin?: IInstalledPluginPackage,
	): Promise<ICanonicalSkillDefinition> {
		const id = basename(directory);
		const resource = joinPath(directory, SKILL_DEFINITION_FILE);
		const pluginState = plugin ? {
			id: plugin.manifest.id,
			enabled: plugin.enabled,
			trusted: plugin.trusted,
		} : undefined;
		if (!await this.fileService.exists(resource)) {
			return {
				id,
				name: id,
				description: '',
				origin,
				resource,
				plugin: pluginState,
				issue: `${SKILL_DEFINITION_FILE} is missing.`,
			};
		}

		try {
			const content = await this.fileService.readFile(resource);
			const parseErrors: YamlParseError[] = [];
			const frontmatter = parseFrontMatter(content.value.toString(), parseErrors);
			const name = frontmatter?.getStringValue('name')?.trim();
			const description = frontmatter?.getStringValue('description')?.trim();
			const environmentCompatibility = frontmatter?.getStringValue('compatibility')?.trim();
			const issues = parseErrors.map(error => error.message);
			const fields = frontmatter?.header?.type === 'map'
				? frontmatter.header.properties.map(property => property.key.value)
				: [];
			const unknownFields = fields.filter(field => !standardFrontmatterFields.has(field));
			if (unknownFields.length > 0) {
				issues.push(`Unsupported Agent Skills frontmatter: ${unknownFields.join(', ')}.`);
			}
			if (!name) {
				issues.push('The Skill definition requires a frontmatter name.');
			} else if (name !== id) {
				issues.push('The frontmatter name must match the Skill directory name.');
			} else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
				issues.push('The Skill name must follow the Agent Skills identifier format.');
			}
			if (!description) {
				issues.push('The Skill definition requires a frontmatter description.');
			} else if (description.length > 1024) {
				issues.push('The Skill description exceeds the Agent Skills 1024-character limit.');
			}
			if (environmentCompatibility && environmentCompatibility.length > 500) {
				issues.push('The Skill compatibility field exceeds the Agent Skills 500-character limit.');
			}
			this.validateStandardFrontmatterTypes(frontmatter?.header, issues);
			const clientCompatibility = await this.resolveClientCompatibility(directory, frontmatter?.header);
			return {
				id,
				name: name || id,
				description: description || '',
				origin,
				resource,
				plugin: pluginState,
				compatibility: clientCompatibility,
				issue: issues.length > 0 ? issues.join(' ') : undefined,
			};
		} catch (error) {
			return {
				id,
				name: id,
				description: '',
				origin,
				resource,
				plugin: pluginState,
				issue: this.toErrorMessage(`Cannot read ${SKILL_DEFINITION_FILE}`, error),
			};
		}
	}

	private flattenSections(sections: ISkillManagementSnapshot['sections']): IEffectiveSkill[] {
		return [...sections.enabled, ...sections.available, ...sections.needsAttention];
	}

	private async resolveClientProjections(
		sections: IEffectiveSkillSections,
		activeRepository: URI | undefined,
	): Promise<IEffectiveSkillSections> {
		const resolveSection = (skills: readonly IEffectiveSkill[]) =>
			Promise.all(skills.map(skill => this.resolveClientProjection(skill, activeRepository)));
		const [enabled, available, needsAttention] = await Promise.all([
			resolveSection(sections.enabled),
			resolveSection(sections.available),
			resolveSection(sections.needsAttention),
		]);
		return { enabled, available, needsAttention };
	}

	private async resolveClientProjection(
		skill: IEffectiveSkill,
		activeRepository: URI | undefined,
	): Promise<IEffectiveSkill> {
		const projections = await Promise.all(projectionClients.map(async client => {
			const compatibility = skill.compatibility.find(candidate => candidate.client === client) ?? {
				client,
				status: 'unsupported' as const,
				reason: skill.issue ?? 'The canonical Skill source is unavailable.',
			};
			try {
				const request = this.createProjectionRequest(skill, activeRepository, compatibility);
				if (!request) {
					return {
						client,
						compatibility: compatibility.status,
						state: 'unsupported',
						overlay: compatibility.overlay,
						detail: compatibility.reason ?? skill.issue ?? 'The canonical Skill source is unavailable.',
						compatibilityReason: compatibility.reason,
					} satisfies ISkillClientProjection;
				}
				const result = await this.projectionService.inspect(request);
				return this.toClientProjection(result, request.target, compatibility);
			} catch (error) {
				return {
					client,
					compatibility: 'unsupported',
					state: 'unsupported',
					overlay: compatibility.overlay,
					detail: this.toErrorMessage(`Cannot inspect ${client} projection`, error),
					compatibilityReason: compatibility.reason,
				} satisfies ISkillClientProjection;
			}
		}));
		return {
			...skill,
			projections,
		};
	}

	private createProjectionRequest(
		skill: IEffectiveSkill,
		activeRepository: URI | undefined,
		compatibility: ISkillClientCompatibility,
	): ISkillProjectionRequest | undefined {
		if (
			skill.section === 'needsAttention' ||
			!skill.definitionResource ||
			!activeRepository ||
			compatibility.status === 'unsupported'
		) {
			return undefined;
		}

		const source = dirname(skill.definitionResource);
		const targetRoot = this.getProjectionTargetRoot(
			compatibility.client,
			skill.origins[0] === 'repository',
			activeRepository,
			Boolean(compatibility.overlay)
		);
		const target = joinPath(targetRoot, skill.id);
		return {
			client: compatibility.client,
			skillId: skill.id,
			source,
			target,
			overlay: compatibility.overlay,
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

	private async runProjectionOperation(
		skill: IEffectiveSkill,
		client: SkillClient,
		operation: (request: ISkillProjectionRequest) => Promise<ISkillProjectionResult>,
	): Promise<void> {
		const compatibility = skill.compatibility.find(candidate => candidate.client === client);
		const request = compatibility && this.createProjectionRequest(
			skill,
			this.repositoryCatalogService.activeRepository,
			compatibility
		);
		if (!request) {
			throw new Error(`Skill "${skill.id}" has no compatible canonical source for ${client}.`);
		}
		const result = await operation(request);
		this.storeProjectionManifest(request.target, result.manifest);
		await this.refresh();
	}

	private toClientProjection(
		result: ISkillProjectionResult,
		target: URI,
		compatibility: ISkillClientCompatibility,
	): ISkillClientProjection {
		return {
			client: compatibility.client,
			compatibility: compatibility.status,
			state: result.state,
			mode: result.mode,
			target,
			overlay: compatibility.overlay,
			detail: result.detail,
			compatibilityReason: compatibility.reason,
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
			projectionClients.includes(candidate.client as SkillClient) &&
			typeof candidate.skillId === 'string' &&
			candidate.mode === 'managed-copy' &&
			typeof candidate.source === 'string' &&
			typeof candidate.target === 'string' &&
			(candidate.overlay === undefined || typeof candidate.overlay === 'string') &&
			typeof candidate.sourceHash === 'string' &&
			typeof candidate.outputHash === 'string';
	}

	private async resolveClientCompatibility(
		directory: URI,
		header: YamlNode | undefined,
	): Promise<ISkillClientCompatibility[]> {
		const fields = header?.type === 'map'
			? header.properties.map(property => property.key.value)
			: [];
		return Promise.all(projectionClients.map(async client => {
			const overlay = joinPath(directory, '.repository-context', 'overlays', `${client}.yaml`);
			const hasOverlay = await this.fileService.exists(overlay);
			const overlayIssue = hasOverlay ? await this.validateClientOverlay(overlay, client) : undefined;
			const unsupportedFields = fields.filter(field => clientUndocumentedStandardFields[client].has(field));
			return {
				client,
				status: overlayIssue
					? 'unsupported'
					: unsupportedFields.length > 0 ? 'partial' : 'compatible',
				reason: overlayIssue ?? (unsupportedFields.length > 0
					? `${client} does not document support for Agent Skills fields: ${unsupportedFields.join(', ')}.`
					: undefined),
				overlay: hasOverlay && !overlayIssue ? overlay : undefined,
			};
		}));
	}

	private async validateClientOverlay(overlay: URI, client: SkillClient): Promise<string | undefined> {
		const errors: YamlParseError[] = [];
		const content = await this.fileService.readFile(overlay);
		const parsed = parse(content.value.toString(), errors);
		if (errors.length > 0) {
			return `Invalid ${client} overlay: ${errors.map(error => error.message).join(' ')}`;
		}
		if (!parsed || parsed.type !== 'map') {
			return `The ${client} overlay must be a YAML mapping.`;
		}
		const unsupported = parsed.properties
			.map(property => property.key.value)
			.filter(field => !clientOverlayFields[client].has(field));
		if (unsupported.length > 0) {
			return `Unsupported ${client} overlay fields: ${unsupported.join(', ')}.`;
		}
		return undefined;
	}

	private validateStandardFrontmatterTypes(header: YamlNode | undefined, issues: string[]): void {
		if (!header || header.type !== 'map') {
			return;
		}
		for (const property of header.properties) {
			const field = property.key.value;
			if (['name', 'description', 'license', 'compatibility', 'allowed-tools'].includes(field) &&
				property.value.type !== 'scalar'
			) {
				issues.push(`The Agent Skills ${field} field must be a string.`);
			}
			if (field === 'metadata') {
				if (property.value.type !== 'map' ||
					property.value.properties.some(metadata => metadata.value.type !== 'scalar')
				) {
					issues.push('The Agent Skills metadata field must contain only string values.');
				}
			}
		}
	}

	private getProjectionTargetRoot(
		client: SkillClient,
		repositoryScoped: boolean,
		activeRepository: URI,
		hasOverlay: boolean,
	): URI {
		const root = repositoryScoped
			? activeRepository
			: this.pathService.userHome({ preferLocal: true });
		switch (client) {
			case 'codex':
				return joinPath(root, '.agents', 'skills');
			case 'claude-code':
				return joinPath(root, '.claude', 'skills');
			case 'cursor':
				return joinPath(root, hasOverlay ? '.cursor' : '.agents', 'skills');
		}
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
