/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IRepoBudMcpHealthService } from '../../../../platform/repoBud/common/mcpHealth.js';
import { IInstalledPluginPackage } from '../../../../platform/repoBud/common/pluginPackage.js';
import {
	createCanonicalConfiguration,
	GLOBAL_CONFIGURATION_FILE,
	ICanonicalConfiguration,
	ICanonicalConfigurationService,
	ICanonicalIntegrationSetting,
	REPOSITORY_CONFIGURATION_DIRECTORY,
	REPOSITORY_CONFIGURATION_FILE,
} from '../common/canonicalConfiguration.js';
import {
	GLOBAL_INTEGRATIONS_DIRECTORY,
	ICanonicalMcpDefinitionResource,
	IDiscoveredMcpHealth,
	IEffectiveMcpIntegration,
	IMcpIntegrationService,
	IMcpIntegrationSnapshot,
	inspectClaudeMcpProjection,
	parseCanonicalMcpDefinition,
	projectClaudeMcpDefinition,
	REPOSITORY_INTEGRATIONS_DIRECTORY,
	resolveEffectiveMcpIntegrations,
} from '../common/mcpIntegration.js';
import { IRepositoryCatalogService } from '../common/repositoryCatalog.js';
import { IContextPluginService } from '../common/pluginManagement.js';
import { SkillProjectionClient } from '../../../../platform/repoBud/common/skillProjection.js';

const emptySections = resolveEffectiveMcpIntegrations([], {}, {});
const CLAUDE_PROJECT_MCP_FILE = '.mcp.json';

export class ContextMcpIntegrationService extends Disposable implements IMcpIntegrationService {

	declare readonly _serviceBrand: undefined;

	private refreshRequest = 0;
	private readonly health = new Map<string, IDiscoveredMcpHealth>();
	private _snapshot: IMcpIntegrationSnapshot;
	private readonly _onDidChange = this._register(new Emitter<IMcpIntegrationSnapshot>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IRepositoryCatalogService private readonly repositoryCatalogService: IRepositoryCatalogService,
		@ICanonicalConfigurationService private readonly canonicalConfigurationService: ICanonicalConfigurationService,
		@IRepoBudMcpHealthService private readonly healthService: IRepoBudMcpHealthService,
		@IContextPluginService private readonly pluginService: IContextPluginService,
	) {
		super();
		this._snapshot = {
			activeRepository: repositoryCatalogService.activeRepository,
			globalRepository: canonicalConfigurationService.globalRepository,
			sections: emptySections,
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
				event.affects(joinPath(globalRepository, GLOBAL_INTEGRATIONS_DIRECTORY))
			);
			const affectsRepository = activeRepository && (
				event.affects(joinPath(activeRepository, REPOSITORY_CONFIGURATION_DIRECTORY, REPOSITORY_CONFIGURATION_FILE)) ||
				event.affects(joinPath(
					activeRepository,
					REPOSITORY_CONFIGURATION_DIRECTORY,
					REPOSITORY_INTEGRATIONS_DIRECTORY
				))
			);
			if (affectsGlobal || affectsRepository) {
				void this.refresh();
			}
		}));

		void this.refresh();
	}

	get snapshot(): IMcpIntegrationSnapshot {
		return this._snapshot;
	}

	async refresh(): Promise<void> {
		const request = ++this.refreshRequest;
		const activeRepository = this.repositoryCatalogService.activeRepository;
		const globalRepository = this.canonicalConfigurationService.globalRepository;
		this.updateSnapshot({ ...this._snapshot, activeRepository, globalRepository, loading: true });

		const errors: string[] = [];
		const [globalConfiguration, repositoryConfiguration, globalDefinitions, repositoryDefinitions, pluginDefinitions] =
			await Promise.all([
				this.readGlobalConfiguration(errors),
				this.readRepositoryConfiguration(activeRepository, errors),
				this.discoverDefinitions(
					globalRepository && joinPath(globalRepository, GLOBAL_INTEGRATIONS_DIRECTORY),
					'global'
				),
				this.discoverDefinitions(
					activeRepository && joinPath(
						activeRepository,
						REPOSITORY_CONFIGURATION_DIRECTORY,
						REPOSITORY_INTEGRATIONS_DIRECTORY
					),
					'repository'
				),
				this.discoverPluginDefinitions(),
			]);
		if (request !== this.refreshRequest) {
			return;
		}
		const resolvedSections = resolveEffectiveMcpIntegrations(
			[...globalDefinitions, ...repositoryDefinitions, ...pluginDefinitions],
			globalConfiguration.integrations,
			repositoryConfiguration.integrations,
			Object.fromEntries(this.health)
		);
		const sections = await this.inspectClaudeProjections(resolvedSections, activeRepository, errors);
		if (request !== this.refreshRequest) {
			return;
		}
		this.updateSnapshot({
			activeRepository,
			globalRepository,
			sections,
			errors,
			loading: false,
		});
	}

	async setRepositoryOverride(
		id: string,
		setting: ICanonicalIntegrationSetting | undefined,
	): Promise<void> {
		const repository = this.repositoryCatalogService.activeRepository;
		if (!repository) {
			throw new Error('Select an active repository before changing an MCP Integration override.');
		}
		const configuration = await this.canonicalConfigurationService.readRepositoryConfiguration(repository);
		const integrations = { ...configuration.integrations };
		if (setting) {
			integrations[id] = setting;
		} else {
			delete integrations[id];
		}
		await this.canonicalConfigurationService.writeRepositoryConfiguration(repository, {
			...configuration,
			integrations,
		});
		await this.refresh();
	}

	async checkHealth(id: string): Promise<void> {
		const integration = this.getIntegration(id);
		if (!integration.definition || integration.section === 'needsAttention') {
			throw new Error(`MCP Integration "${id}" has no valid canonical definition.`);
		}
		this.health.set(id, { state: 'checking', capabilities: [] });
		await this.refresh();
		const result = await this.healthService.check({
			id,
			transport: integration.definition.transport,
			repository: this.repositoryCatalogService.activeRepository,
		});
		this.health.set(id, result);
		await this.refresh();
	}

	async project(id: string, client: SkillProjectionClient, replace = false): Promise<void> {
		if (client !== 'claude-code') {
			throw new Error(`MCP projection to ${client} is not supported by this release.`);
		}
		const repository = this.repositoryCatalogService.activeRepository;
		if (!repository) {
			throw new Error('Select an active repository before projecting an MCP Integration.');
		}
		const integration = this.getIntegration(id);
		if (!integration.definition || integration.section === 'needsAttention') {
			throw new Error(`MCP Integration "${id}" has no valid canonical definition.`);
		}
		if (!integration.clients.includes(client)) {
			throw new Error(`MCP Integration "${id}" is not enabled for Claude Code.`);
		}
		const target = joinPath(repository, CLAUDE_PROJECT_MCP_FILE);
		const raw = await this.readOptionalText(target);
		const projected = projectClaudeMcpDefinition(raw, integration.definition, replace);
		await this.fileService.writeFile(
			target,
			VSBuffer.fromString(projected),
			{ atomic: { postfix: '.repobud-tmp' } }
		);
		await this.refresh();
	}

	private async inspectClaudeProjections(
		sections: IMcpIntegrationSnapshot['sections'],
		repository: URI | undefined,
		errors: string[],
	): Promise<IMcpIntegrationSnapshot['sections']> {
		if (!repository) {
			return sections;
		}
		const target = joinPath(repository, CLAUDE_PROJECT_MCP_FILE);
		let raw: string | undefined;
		try {
			raw = await this.readOptionalText(target);
		} catch (error) {
			errors.push(this.toErrorMessage('Claude project MCP configuration', error));
			return sections;
		}
		const inspect = (integration: IEffectiveMcpIntegration): IEffectiveMcpIntegration => {
			const projection = integration.projections.find(candidate => candidate.client === 'claude-code');
			if (!projection || projection.state === 'unselected' || !integration.definition) {
				return integration;
			}
			let state: 'missing' | 'projected' | 'conflict';
			let detail: string | undefined;
			try {
				state = inspectClaudeMcpProjection(raw, integration.definition);
				detail = state === 'conflict'
					? 'The existing Claude project entry differs from the canonical definition.'
					: undefined;
			} catch (error) {
				state = 'conflict';
				detail = error instanceof Error ? error.message : String(error);
			}
			return {
				...integration,
				projections: integration.projections.map(candidate => candidate.client === 'claude-code'
					? { client: 'claude-code', state, target, detail }
					: candidate
				),
			};
		};
		return {
			enabled: sections.enabled.map(inspect),
			available: sections.available.map(inspect),
			needsAttention: sections.needsAttention.map(inspect),
		};
	}

	private async readOptionalText(resource: URI): Promise<string | undefined> {
		if (!await this.fileService.exists(resource)) {
			return undefined;
		}
		const content = await this.fileService.readFile(resource, { atomic: true });
		return content.value.toString();
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

	private async discoverDefinitions(
		root: URI | undefined,
		origin: ICanonicalMcpDefinitionResource['origin'],
	): Promise<ICanonicalMcpDefinitionResource[]> {
		if (!root || !await this.fileService.exists(root)) {
			return [];
		}
		try {
			const resolved = await this.fileService.resolve(root);
			const files = resolved.children?.filter(child => !child.isDirectory && child.name.endsWith('.json')) ?? [];
			return Promise.all(files.map(file => this.readDefinition(file.resource, origin)));
		} catch (error) {
			return [{
				id: basename(root),
				origin,
				resource: root,
				issue: this.toErrorMessage('Cannot read MCP Integration library', error),
			}];
		}
	}

	private async readDefinition(
		resource: URI,
		origin: ICanonicalMcpDefinitionResource['origin'],
		plugin?: IInstalledPluginPackage,
	): Promise<ICanonicalMcpDefinitionResource> {
		const id = basename(resource).replace(/\.json$/, '');
		const pluginState = plugin ? {
			id: plugin.manifest.id,
			enabled: plugin.enabled,
			trusted: plugin.trusted,
		} : undefined;
		try {
			const content = await this.fileService.readFile(resource);
			return {
				id,
				origin,
				resource,
				plugin: pluginState,
				definition: parseCanonicalMcpDefinition(content.value.toString(), id),
			};
		} catch (error) {
			return {
				id,
				origin,
				resource,
				plugin: pluginState,
				issue: this.toErrorMessage(`Cannot read MCP definition "${id}"`, error),
			};
		}
	}

	private async discoverPluginDefinitions(): Promise<ICanonicalMcpDefinitionResource[]> {
		const definitions = await Promise.all(this.pluginService.snapshot.installed.flatMap(plugin =>
			plugin.manifest.integrations.map(integration =>
				this.readDefinition(joinPath(plugin.resource, integration), 'plugin', plugin)
			)
		));
		return definitions.sort((left, right) => left.id.localeCompare(right.id));
	}

	private getIntegration(id: string): IEffectiveMcpIntegration {
		const integrations = [
			...this._snapshot.sections.enabled,
			...this._snapshot.sections.available,
			...this._snapshot.sections.needsAttention,
		];
		const integration = integrations.find(candidate => candidate.id === id);
		if (!integration) {
			throw new Error(`MCP Integration "${id}" is not available in the active repository.`);
		}
		return integration;
	}

	private toErrorMessage(context: string, error: unknown): string {
		return `${context}: ${error instanceof Error ? error.message : String(error)}`;
	}

	private updateSnapshot(snapshot: IMcpIntegrationSnapshot): void {
		this._snapshot = snapshot;
		this._onDidChange.fire(snapshot);
	}
}

registerSingleton(IMcpIntegrationService, ContextMcpIntegrationService, InstantiationType.Delayed);
