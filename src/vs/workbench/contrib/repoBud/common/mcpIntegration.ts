/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { SkillProjectionClient } from '../../../../platform/repoBud/common/skillProjection.js';
import {
	CanonicalActivation,
	ICanonicalIntegrationSetting,
} from './canonicalConfiguration.js';

export const GLOBAL_INTEGRATIONS_DIRECTORY = 'integrations';
export const REPOSITORY_INTEGRATIONS_DIRECTORY = 'integrations';

export type McpIntegrationOrigin = 'global' | 'repository' | 'plugin';
export type McpIntegrationSection = 'enabled' | 'available' | 'needsAttention';
export type McpHealthState = 'unknown' | 'checking' | 'healthy' | 'unreachable';
export type McpProjectionState = 'unselected' | 'unsupported' | 'missing' | 'projected' | 'conflict';

export interface ICanonicalStdioMcpTransport {
	readonly type: 'stdio';
	readonly command: string;
	readonly args: readonly string[];
}

export interface ICanonicalHttpMcpTransport {
	readonly type: 'http';
	readonly url: string;
}

export type ICanonicalMcpTransport = ICanonicalStdioMcpTransport | ICanonicalHttpMcpTransport;

export interface ICanonicalMcpDefinition {
	readonly version: 1;
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly transport: ICanonicalMcpTransport;
	readonly connection?: {
		readonly provider: 'github';
	};
}

export interface IDiscoveredMcpHealth {
	readonly state: McpHealthState;
	readonly checkedAt?: number;
	readonly protocolVersion?: string;
	readonly capabilities: readonly string[];
	readonly detail?: string;
}

export interface IMcpClientProjection {
	readonly client: SkillProjectionClient;
	readonly state: McpProjectionState;
	readonly target?: URI;
	readonly detail?: string;
}

export interface ICanonicalMcpDefinitionResource {
	readonly id: string;
	readonly definition?: ICanonicalMcpDefinition;
	readonly origin: McpIntegrationOrigin;
	readonly resource: URI;
	readonly plugin?: {
		readonly id: string;
		readonly enabled: boolean;
		readonly trusted: boolean;
	};
	readonly issue?: string;
}

export interface IEffectiveMcpIntegration {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly origins: readonly McpIntegrationOrigin[];
	readonly activation: CanonicalActivation;
	readonly clients: readonly SkillProjectionClient[];
	readonly repositoryOverride: ICanonicalIntegrationSetting | undefined;
	readonly section: McpIntegrationSection;
	readonly definition?: ICanonicalMcpDefinition;
	readonly definitionResource?: URI;
	readonly health: IDiscoveredMcpHealth;
	readonly projections: readonly IMcpClientProjection[];
	readonly issue?: string;
}

export interface IEffectiveMcpSections {
	readonly enabled: readonly IEffectiveMcpIntegration[];
	readonly available: readonly IEffectiveMcpIntegration[];
	readonly needsAttention: readonly IEffectiveMcpIntegration[];
}

export interface IMcpIntegrationSnapshot {
	readonly activeRepository: URI | undefined;
	readonly globalRepository: URI | undefined;
	readonly sections: IEffectiveMcpSections;
	readonly errors: readonly string[];
	readonly loading: boolean;
}

export const IMcpIntegrationService = createDecorator<IMcpIntegrationService>('mcpIntegrationService');

export interface IMcpIntegrationService {
	readonly _serviceBrand: undefined;
	readonly snapshot: IMcpIntegrationSnapshot;
	readonly onDidChange: Event<IMcpIntegrationSnapshot>;

	refresh(): Promise<void>;
	setRepositoryOverride(id: string, setting: ICanonicalIntegrationSetting | undefined): Promise<void>;
	checkHealth(id: string): Promise<void>;
	project(id: string, client: SkillProjectionClient, replace?: boolean): Promise<void>;
}

const supportedClients: readonly SkillProjectionClient[] = ['codex', 'claude-code', 'cursor'];
const originOrder: readonly McpIntegrationOrigin[] = ['repository', 'global', 'plugin'];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
	const allowedKeys = new Set(allowed);
	const unsupported = Object.keys(value).filter(key => !allowedKeys.has(key));
	if (unsupported.length > 0) {
		throw new Error(`${context} contains unsupported fields: ${unsupported.sort().join(', ')}`);
	}
}

function containsCredentialHint(value: string): boolean {
	return /(?:^|[-_./?&])(?:api[-_]?key|authorization|bearer|password|secret|token)(?:$|[=:_-])/i.test(value);
}

export function parseCanonicalMcpDefinition(raw: string, expectedId?: string): ICanonicalMcpDefinition {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error('MCP definition must contain valid JSON.');
	}
	if (!isRecord(value)) {
		throw new Error('MCP definition must be an object.');
	}
	assertExactKeys(value, ['version', 'id', 'name', 'description', 'transport', 'connection'], 'MCP definition');
	if (value.version !== 1) {
		throw new Error('MCP definition version must be 1.');
	}
	if (typeof value.id !== 'string' || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value.id)) {
		throw new Error('MCP definition ID is invalid.');
	}
	if (expectedId && value.id !== expectedId) {
		throw new Error(`MCP definition ID must match its file name: ${expectedId}`);
	}
	if (typeof value.name !== 'string' || !value.name.trim()) {
		throw new Error('MCP definition name must be a non-empty string.');
	}
	if (typeof value.description !== 'string' || !value.description.trim()) {
		throw new Error('MCP definition description must be a non-empty string.');
	}
	if (!isRecord(value.transport)) {
		throw new Error('MCP definition transport must be an object.');
	}
	if (value.connection !== undefined) {
		if (!isRecord(value.connection)) {
			throw new Error('MCP definition connection must be an object.');
		}
		assertExactKeys(value.connection, ['provider'], 'MCP definition connection');
		if (value.connection.provider !== 'github') {
			throw new Error('MCP definition connection provider must be "github".');
		}
	}

	let transport: ICanonicalMcpTransport;
	if (value.transport.type === 'stdio') {
		assertExactKeys(value.transport, ['type', 'command', 'args'], 'MCP stdio transport');
		if (typeof value.transport.command !== 'string' || !value.transport.command.trim()) {
			throw new Error('MCP stdio command must be a non-empty string.');
		}
		if (!Array.isArray(value.transport.args) ||
			value.transport.args.some(argument => typeof argument !== 'string')
		) {
			throw new Error('MCP stdio args must be an array of strings.');
		}
		if (
			containsCredentialHint(value.transport.command) ||
			(value.transport.args as string[]).some(containsCredentialHint)
		) {
			throw new Error('MCP stdio command and args must not contain credential values or credential flags.');
		}
		transport = {
			type: 'stdio',
			command: value.transport.command,
			args: value.transport.args as string[],
		};
	} else if (value.transport.type === 'http') {
		assertExactKeys(value.transport, ['type', 'url'], 'MCP HTTP transport');
		if (typeof value.transport.url !== 'string') {
			throw new Error('MCP HTTP URL must be a string.');
		}
		let url: URL;
		try {
			url = new URL(value.transport.url);
		} catch {
			throw new Error('MCP HTTP URL must be valid.');
		}
		if (url.protocol !== 'https:' && url.protocol !== 'http:') {
			throw new Error('MCP HTTP URL must use HTTP or HTTPS.');
		}
		if (url.username || url.password || url.search || url.hash || containsCredentialHint(url.toString())) {
			throw new Error('MCP HTTP URL must not contain credentials, query parameters, or fragments.');
		}
		transport = { type: 'http', url: url.toString() };
	} else {
		throw new Error('MCP transport type must be "stdio" or "http".');
	}

	return {
		version: 1,
		id: value.id,
		name: value.name.trim(),
		description: value.description.trim(),
		transport,
		...(value.connection ? { connection: { provider: 'github' as const } } : {}),
	};
}

export function serializeCanonicalMcpDefinition(definition: ICanonicalMcpDefinition): string {
	const validated = parseCanonicalMcpDefinition(JSON.stringify(definition), definition.id);
	return `${JSON.stringify(validated, null, '\t')}\n`;
}

function compareIntegrations(left: IEffectiveMcpIntegration, right: IEffectiveMcpIntegration): number {
	return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

export function resolveEffectiveMcpIntegrations(
	resources: readonly ICanonicalMcpDefinitionResource[],
	globalSettings: Readonly<Record<string, ICanonicalIntegrationSetting>>,
	repositorySettings: Readonly<Record<string, ICanonicalIntegrationSetting>>,
	health: Readonly<Record<string, IDiscoveredMcpHealth>> = {},
): IEffectiveMcpSections {
	const resourcesById = new Map<string, ICanonicalMcpDefinitionResource[]>();
	for (const resource of resources) {
		const existing = resourcesById.get(resource.id) ?? [];
		existing.push(resource);
		resourcesById.set(resource.id, existing);
	}
	const ids = new Set([
		...resourcesById.keys(),
		...Object.keys(globalSettings),
		...Object.keys(repositorySettings),
	]);
	const sections: Record<McpIntegrationSection, IEffectiveMcpIntegration[]> = {
		enabled: [],
		available: [],
		needsAttention: [],
	};

	for (const id of ids) {
		const candidates = resourcesById.get(id) ?? [];
		const issues = candidates.flatMap(candidate => candidate.issue ? [candidate.issue] : []);
		if (candidates.length === 0) {
			issues.push(`No canonical MCP definition exists for "${id}".`);
		} else if (candidates.length > 1) {
			issues.push(`Conflicting canonical MCP definitions exist for "${id}".`);
		}
		const preferred = candidates.find(candidate => candidate.origin === 'repository') ?? candidates[0];
		if (preferred?.plugin && !preferred.plugin.trusted) {
			issues.push(`Plugin "${preferred.plugin.id}" has untrusted executable content.`);
		}
		const origins = [...new Set(candidates.map(candidate => candidate.origin))]
			.sort((left, right) => originOrder.indexOf(left) - originOrder.indexOf(right));
		const globalSetting = globalSettings[id];
		const repositorySetting = repositorySettings[id];
		const activation = preferred?.plugin && !preferred.plugin.enabled
			? 'off'
			: repositorySetting?.activation ?? globalSetting?.activation ?? 'on';
		const clients = repositorySetting?.clients ?? globalSetting?.clients ?? supportedClients;
		const section: McpIntegrationSection = issues.length > 0
			? 'needsAttention'
			: activation === 'on' ? 'enabled' : 'available';
		sections[section].push({
			id,
			name: preferred?.definition?.name ?? id,
			description: preferred?.definition?.description ?? '',
			origins,
			activation,
			clients,
			repositoryOverride: repositorySetting,
			section,
			definition: preferred?.definition,
			definitionResource: preferred?.resource,
			health: health[id] ?? { state: 'unknown', capabilities: [] },
			projections: supportedClients.map(client => ({
				client,
				state: clients.includes(client) ? 'unsupported' : 'unselected',
				detail: clients.includes(client)
					? 'No compatible project adapter has inspected this target.'
					: undefined,
			})),
			issue: issues.length > 0 ? issues.join(' ') : undefined,
		});
	}

	return {
		enabled: sections.enabled.sort(compareIntegrations),
		available: sections.available.sort(compareIntegrations),
		needsAttention: sections.needsAttention.sort(compareIntegrations),
	};
}

export interface IClaudeMcpProjectFile {
	readonly mcpServers: Readonly<Record<string, unknown>>;
	readonly [key: string]: unknown;
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(stableValue);
	}
	if (isRecord(value)) {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, stableValue(child)])
		);
	}
	return value;
}

export function toClaudeMcpServer(definition: ICanonicalMcpDefinition): Record<string, unknown> {
	return definition.transport.type === 'stdio'
		? {
			type: 'stdio',
			command: definition.transport.command,
			args: [...definition.transport.args],
		}
		: {
			type: 'http',
			url: definition.transport.url,
		};
}

export function parseClaudeMcpProject(raw: string | undefined): IClaudeMcpProjectFile {
	if (raw === undefined) {
		return { mcpServers: {} };
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error('Claude project MCP configuration must contain valid JSON.');
	}
	if (!isRecord(value)) {
		throw new Error('Claude project MCP configuration must be an object.');
	}
	if (value.mcpServers !== undefined && !isRecord(value.mcpServers)) {
		throw new Error('Claude project MCP configuration mcpServers must be an object.');
	}
	return {
		...value,
		mcpServers: value.mcpServers ?? {},
	};
}

export function inspectClaudeMcpProjection(
	raw: string | undefined,
	definition: ICanonicalMcpDefinition,
): 'missing' | 'projected' | 'conflict' {
	const project = parseClaudeMcpProject(raw);
	const existing = project.mcpServers[definition.id];
	if (existing === undefined) {
		return 'missing';
	}
	return JSON.stringify(stableValue(existing)) === JSON.stringify(stableValue(toClaudeMcpServer(definition)))
		? 'projected'
		: 'conflict';
}

export function projectClaudeMcpDefinition(
	raw: string | undefined,
	definition: ICanonicalMcpDefinition,
	replace = false,
): string {
	const project = parseClaudeMcpProject(raw);
	const state = inspectClaudeMcpProjection(raw, definition);
	if (state === 'conflict' && !replace) {
		throw new Error(
			`Claude project MCP server "${definition.id}" differs from the canonical definition.`
		);
	}
	return `${JSON.stringify({
		...project,
		mcpServers: {
			...project.mcpServers,
			[definition.id]: toClaudeMcpServer(definition),
		},
	}, null, '\t')}\n`;
}
