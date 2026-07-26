/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { parseFrontMatter, YamlParseError } from '../../../../base/common/yaml.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
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
	ISkillManagementSnapshot,
	REPOSITORY_SKILLS_DIRECTORY,
	resolveEffectiveSkills,
	SKILL_DEFINITION_FILE,
	SkillOrigin,
	SkillOverride,
} from '../common/skillManagement.js';

const emptySections = resolveEffectiveSkills([], {}, {});

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

		const sections = resolveEffectiveSkills(
			[...globalDefinitions, ...repositoryDefinitions],
			globalConfiguration.skills,
			repositoryConfiguration.skills
		);
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

	private toErrorMessage(context: string, error: unknown): string {
		return `${context}: ${error instanceof Error ? error.message : String(error)}`;
	}

	private updateSnapshot(snapshot: ISkillManagementSnapshot): void {
		this._snapshot = snapshot;
		this._onDidChange.fire(snapshot);
	}
}

registerSingleton(IContextSkillService, ContextSkillService, InstantiationType.Delayed);
