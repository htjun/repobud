/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { SkillProjectionClient } from '../../../../platform/repositoryContext/common/skillProjection.js';

export const GLOBAL_CONFIGURATION_FILE = 'repository-context.json';
export const REPOSITORY_CONFIGURATION_DIRECTORY = '.repository-context';
export const REPOSITORY_CONFIGURATION_FILE = 'config.json';

export type CanonicalConfigurationScope = 'global' | 'repository';
export type CanonicalActivation = 'on' | 'off';

export interface ICanonicalCapabilitySetting {
	readonly activation: CanonicalActivation;
}

export interface ICanonicalIntegrationSetting {
	readonly activation?: CanonicalActivation;
	readonly clients?: readonly SkillProjectionClient[];
}

export interface ICanonicalConfiguration {
	readonly version: 1;
	readonly scope: CanonicalConfigurationScope;
	readonly skills: Readonly<Record<string, ICanonicalCapabilitySetting>>;
	readonly integrations: Readonly<Record<string, ICanonicalIntegrationSetting>>;
}

export const ICanonicalConfigurationService = createDecorator<ICanonicalConfigurationService>('canonicalConfigurationService');

export interface ICanonicalConfigurationService {
	readonly _serviceBrand: undefined;
	readonly globalRepository: URI | undefined;
	readonly onDidChangeGlobalRepository: Event<URI | undefined>;

	adoptGlobalRepository(uri: URI): Promise<void>;
	readGlobalConfiguration(): Promise<ICanonicalConfiguration | undefined>;
	writeGlobalConfiguration(configuration: ICanonicalConfiguration): Promise<void>;
	readRepositoryConfiguration(repository: URI): Promise<ICanonicalConfiguration>;
	writeRepositoryConfiguration(repository: URI, configuration: ICanonicalConfiguration): Promise<void>;
}

export function createCanonicalConfiguration(scope: CanonicalConfigurationScope): ICanonicalConfiguration {
	return {
		version: 1,
		scope,
		skills: {},
		integrations: {},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowedKeys: readonly string[], context: string): void {
	const allowed = new Set(allowedKeys);
	const unsupportedKeys = Object.keys(value).filter(key => !allowed.has(key));
	if (unsupportedKeys.length > 0) {
		throw new Error(`${context} contains unsupported fields: ${unsupportedKeys.sort().join(', ')}`);
	}
}

function parseCapabilitySettings(value: unknown, context: string): Record<string, ICanonicalCapabilitySetting> {
	if (!isRecord(value)) {
		throw new Error(`${context} must be an object.`);
	}

	const result: Record<string, ICanonicalCapabilitySetting> = {};
	for (const [id, setting] of Object.entries(value)) {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
			throw new Error(`${context} contains an invalid capability ID: ${id}`);
		}
		if (!isRecord(setting)) {
			throw new Error(`${context}.${id} must be an object.`);
		}
		assertExactKeys(setting, ['activation'], `${context}.${id}`);
		if (setting.activation !== 'on' && setting.activation !== 'off') {
			throw new Error(`${context}.${id}.activation must be "on" or "off".`);
		}
		result[id] = { activation: setting.activation };
	}

	return result;
}

function parseIntegrationSettings(
	value: unknown,
	context: string,
): Record<string, ICanonicalIntegrationSetting> {
	if (!isRecord(value)) {
		throw new Error(`${context} must be an object.`);
	}

	const result: Record<string, ICanonicalIntegrationSetting> = {};
	for (const [id, setting] of Object.entries(value)) {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
			throw new Error(`${context} contains an invalid capability ID: ${id}`);
		}
		if (!isRecord(setting)) {
			throw new Error(`${context}.${id} must be an object.`);
		}
		assertExactKeys(setting, ['activation', 'clients'], `${context}.${id}`);
		if (setting.activation !== undefined && setting.activation !== 'on' && setting.activation !== 'off') {
			throw new Error(`${context}.${id}.activation must be "on" or "off".`);
		}
		if (setting.clients !== undefined && (
			!Array.isArray(setting.clients) ||
			setting.clients.some(client => !['codex', 'claude-code', 'cursor'].includes(String(client))) ||
			new Set(setting.clients).size !== setting.clients.length
		)) {
			throw new Error(`${context}.${id}.clients must contain unique supported client IDs.`);
		}
		if (setting.activation === undefined && setting.clients === undefined) {
			throw new Error(`${context}.${id} must override activation or clients.`);
		}
		result[id] = {
			...(setting.activation ? { activation: setting.activation } : {}),
			...(setting.clients ? { clients: setting.clients as SkillProjectionClient[] } : {}),
		};
	}
	return result;
}

export function parseCanonicalConfiguration(
	raw: string,
	expectedScope?: CanonicalConfigurationScope,
): ICanonicalConfiguration {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error('Canonical configuration must contain valid JSON.');
	}

	if (!isRecord(value)) {
		throw new Error('Canonical configuration must be an object.');
	}
	assertExactKeys(value, ['version', 'scope', 'skills', 'integrations'], 'Canonical configuration');
	if (value.version !== 1) {
		throw new Error('Canonical configuration version must be 1.');
	}
	if (value.scope !== 'global' && value.scope !== 'repository') {
		throw new Error('Canonical configuration scope must be "global" or "repository".');
	}
	if (expectedScope && value.scope !== expectedScope) {
		throw new Error(`Expected ${expectedScope} configuration, but found ${value.scope} configuration.`);
	}

	return {
		version: 1,
		scope: value.scope,
		skills: parseCapabilitySettings(value.skills, 'skills'),
		integrations: parseIntegrationSettings(value.integrations, 'integrations'),
	};
}

function sortCapabilitySettings(
	settings: Readonly<Record<string, ICanonicalCapabilitySetting | ICanonicalIntegrationSetting>>,
): Record<string, ICanonicalCapabilitySetting | ICanonicalIntegrationSetting> {
	return Object.fromEntries(
		Object.entries(settings).sort(([left], [right]) => left.localeCompare(right))
	);
}

export function serializeCanonicalConfiguration(configuration: ICanonicalConfiguration): string {
	const validated = parseCanonicalConfiguration(JSON.stringify(configuration), configuration.scope);
	return `${JSON.stringify({
		version: 1,
		scope: validated.scope,
		skills: sortCapabilitySettings(validated.skills),
		integrations: sortCapabilitySettings(validated.integrations),
	}, null, '\t')}\n`;
}
