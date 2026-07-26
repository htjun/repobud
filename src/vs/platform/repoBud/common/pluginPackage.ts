/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const PLUGIN_MANIFEST_FILE = 'repobud-plugin.json';
export const PLUGIN_INSTALL_RECORD_FILE = '.repobud-install.json';
export const PLUGINS_DIRECTORY = 'plugins';

export type PluginUpdateStrategy = 'apply' | 'merge' | 'fork';

export interface ILocalPluginSourceRequest {
	readonly type: 'local';
	readonly location: URI;
}

export interface IGitPluginSourceRequest {
	readonly type: 'git';
	readonly url: string;
	readonly revision: string;
}

export type IPluginSourceRequest = ILocalPluginSourceRequest | IGitPluginSourceRequest;

export interface IResolvedLocalPluginSource {
	readonly type: 'local';
	readonly label: string;
	readonly locatorRef: string;
}

interface IResolvedGitPluginSourceBase {
	readonly type: 'git';
	readonly requestedRevision: string;
	readonly revision: string;
}

export interface IResolvedRemoteGitPluginSource extends IResolvedGitPluginSourceBase {
	readonly locationType: 'remote';
	readonly url: string;
}

export interface IResolvedLocalGitPluginSource extends IResolvedGitPluginSourceBase {
	readonly locationType: 'local';
	readonly label: string;
	readonly locatorRef: string;
}

export type IResolvedGitPluginSource =
	IResolvedRemoteGitPluginSource |
	IResolvedLocalGitPluginSource;

export interface IResolvedForkPluginSource {
	readonly type: 'fork';
	readonly pluginId: string;
	readonly contentHash: string;
}

export type IResolvedPluginSource =
	IResolvedLocalPluginSource |
	IResolvedGitPluginSource |
	IResolvedForkPluginSource;

export interface IPluginConnectionRequirement {
	readonly provider: 'github';
}

export interface IPluginPackageManifest {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly name: string;
	readonly version: string;
	readonly license: string;
	readonly skills: readonly string[];
	readonly integrations: readonly string[];
	readonly scripts: readonly string[];
	readonly connections: readonly IPluginConnectionRequirement[];
}

export interface IPluginFileChange {
	readonly path: string;
	readonly kind: 'added' | 'modified' | 'deleted';
}

export interface IPluginPackagePreview {
	readonly manifest: IPluginPackageManifest;
	readonly source: IResolvedPluginSource;
	readonly contentHash: string;
	readonly files: readonly string[];
	readonly trustRequired: boolean;
}

export interface IInstalledPluginPackage {
	readonly manifest: IPluginPackageManifest;
	readonly source: IResolvedPluginSource;
	readonly contentHash: string;
	readonly currentContentHash: string;
	readonly enabled: boolean;
	readonly trusted: boolean;
	readonly installedAt: number;
	readonly updatedAt?: number;
	readonly localModified: boolean;
	readonly resource: URI;
}

export interface IPluginPackageUpdate {
	readonly installed: IInstalledPluginPackage;
	readonly preview: IPluginPackagePreview;
	readonly changes: readonly IPluginFileChange[];
}

export interface IPluginUpdateResult {
	readonly installed: IInstalledPluginPackage;
	readonly forkedPluginId?: string;
	readonly conflicts?: readonly string[];
}

export const IRepoBudPluginPackageService =
	createDecorator<IRepoBudPluginPackageService>('repoBudPluginPackageService');

export interface IRepoBudPluginPackageService {
	readonly _serviceBrand: undefined;

	preview(source: IPluginSourceRequest): Promise<IPluginPackagePreview>;
	install(
		configurationRepository: URI,
		source: IPluginSourceRequest,
		expectedContentHash: string,
		trustExecutableContent: boolean,
	): Promise<IInstalledPluginPackage>;
	list(configurationRepository: URI): Promise<readonly IInstalledPluginPackage[]>;
	setEnabled(
		configurationRepository: URI,
		pluginId: string,
		enabled: boolean,
	): Promise<IInstalledPluginPackage>;
	grantTrust(
		configurationRepository: URI,
		pluginId: string,
	): Promise<IInstalledPluginPackage>;
	uninstall(configurationRepository: URI, pluginId: string): Promise<void>;
	checkUpdates(configurationRepository: URI): Promise<readonly IPluginPackageUpdate[]>;
	applyUpdate(
		configurationRepository: URI,
		pluginId: string,
		strategy: PluginUpdateStrategy,
		expectedContentHash: string,
		trustExecutableContent: boolean,
	): Promise<IPluginUpdateResult>;
}

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

function parsePaths(value: unknown, context: string): string[] {
	if (!Array.isArray(value) || value.some(path => typeof path !== 'string')) {
		throw new Error(`${context} must be an array of relative paths.`);
	}
	const paths = value as string[];
	if (new Set(paths).size !== paths.length) {
		throw new Error(`${context} must not contain duplicate paths.`);
	}
	for (const path of paths) {
		if (
			!path ||
			path.startsWith('/') ||
			path.startsWith('\\') ||
			path.split(/[\\/]/).some(segment => segment === '..' || segment === '.' || !segment)
		) {
			throw new Error(`${context} contains an unsafe relative path: ${path}`);
		}
	}
	return [...paths].sort();
}

export function parsePluginPackageManifest(raw: string): IPluginPackageManifest {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error('Plugin manifest must contain valid JSON.');
	}
	if (!isRecord(value)) {
		throw new Error('Plugin manifest must be an object.');
	}
	assertExactKeys(
		value,
		['schemaVersion', 'id', 'name', 'version', 'license', 'skills', 'integrations', 'scripts', 'connections'],
		'Plugin manifest'
	);
	if (value.schemaVersion !== 1) {
		throw new Error('Plugin manifest schemaVersion must be 1.');
	}
	if (typeof value.id !== 'string' || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value.id)) {
		throw new Error('Plugin manifest id is invalid.');
	}
	if (typeof value.name !== 'string' || !value.name.trim()) {
		throw new Error('Plugin manifest name must be a non-empty string.');
	}
	if (
		typeof value.version !== 'string' ||
		!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value.version)
	) {
		throw new Error('Plugin manifest version must be a semantic version.');
	}
	if (typeof value.license !== 'string' || !value.license.trim()) {
		throw new Error('Plugin manifest license must be a non-empty string.');
	}
	const skills = parsePaths(value.skills, 'Plugin manifest skills');
	const integrations = parsePaths(value.integrations, 'Plugin manifest integrations');
	const scripts = parsePaths(value.scripts, 'Plugin manifest scripts');
	if (!Array.isArray(value.connections)) {
		throw new Error('Plugin manifest connections must be an array.');
	}
	const connections = value.connections.map((connection, index) => {
		if (!isRecord(connection)) {
			throw new Error(`Plugin manifest connections[${index}] must be an object.`);
		}
		assertExactKeys(connection, ['provider'], `Plugin manifest connections[${index}]`);
		if (connection.provider !== 'github') {
			throw new Error(`Plugin manifest connections[${index}].provider must be "github".`);
		}
		return { provider: 'github' as const };
	});
	if (new Set(connections.map(connection => connection.provider)).size !== connections.length) {
		throw new Error('Plugin manifest connections must not contain duplicate providers.');
	}
	return {
		schemaVersion: 1,
		id: value.id,
		name: value.name.trim(),
		version: value.version,
		license: value.license.trim(),
		skills,
		integrations,
		scripts,
		connections,
	};
}
