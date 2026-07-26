/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { promisify } from 'util';
import { Schemas } from '../../../base/common/network.js';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from '../../../base/common/path.js';
import { URI } from '../../../base/common/uri.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import {
	IInstalledPluginPackage,
	IPluginFileChange,
	IPluginPackageManifest,
	IPluginPackagePreview,
	IPluginPackageUpdate,
	IPluginSourceRequest,
	IPluginUpdateResult,
	IRepoBudPluginPackageService,
	IResolvedPluginSource,
	PLUGIN_INSTALL_RECORD_FILE,
	PLUGIN_MANIFEST_FILE,
	PLUGINS_DIRECTORY,
	PluginUpdateStrategy,
	parsePluginPackageManifest,
} from '../common/pluginPackage.js';

const execFileAsync = promisify(execFile);
const BASELINES_DIRECTORY = '.baselines';
const INSTALL_RECORD_SCHEMA_VERSION = 1;
const LOCAL_SOURCE_REGISTRY_SCHEMA_VERSION = 1;

interface ILocalSourceRegistry {
	readonly schemaVersion: 1;
	readonly locations: Readonly<Record<string, string>>;
}

interface IPluginInstallRecord {
	readonly schemaVersion: 1;
	readonly source: IResolvedPluginSource;
	readonly contentHash: string;
	readonly trustedContentHash?: string;
	readonly enabled: boolean;
	readonly installedAt: number;
	readonly updatedAt?: number;
}

interface IMaterializedPlugin {
	readonly root: string;
	readonly source: IResolvedPluginSource;
	readonly machineSourceLocation?: string;
	readonly cleanup?: () => Promise<void>;
}

interface IInspectedPlugin {
	readonly manifest: IPluginPackageManifest;
	readonly contentHash: string;
	readonly files: readonly string[];
	readonly fileHashes: ReadonlyMap<string, string>;
	readonly trustRequired: boolean;
}

/**
 * Implements trusted Plugin package lifecycle operations in the Electron main process.
 */
export class RepoBudPluginPackageMainService implements IRepoBudPluginPackageService {

	declare readonly _serviceBrand: undefined;

	private readonly localSourceLocations = new Map<string, string>();
	private localSourceRegistryLoaded = false;

	constructor(
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
	) { }

	async preview(source: IPluginSourceRequest): Promise<IPluginPackagePreview> {
		const materialized = await this.materialize(source);
		try {
			return this.toPreview(await this.inspectRoot(materialized.root), materialized.source);
		} finally {
			await materialized.cleanup?.();
		}
	}

	async install(
		configurationRepository: URI,
		source: IPluginSourceRequest,
		expectedContentHash: string,
		trustExecutableContent: boolean,
	): Promise<IInstalledPluginPackage> {
		const configurationRoot = this.resolveConfigurationRepository(configurationRepository);
		const materialized = await this.materialize(source);
		try {
			const inspected = await this.inspectRoot(materialized.root);
			this.assertExpectedPreview(inspected, expectedContentHash);
			const target = this.pluginPath(configurationRoot, inspected.manifest.id);
			if (await this.pathExists(target)) {
				throw new Error(`Plugin "${inspected.manifest.id}" is already installed.`);
			}
			const now = Date.now();
			await this.replaceInstallation(
				configurationRoot,
				target,
				materialized.root,
				{
					schemaVersion: INSTALL_RECORD_SCHEMA_VERSION,
					source: materialized.source,
					contentHash: inspected.contentHash,
					trustedContentHash: trustExecutableContent || !inspected.trustRequired
						? inspected.contentHash
						: undefined,
					enabled: !inspected.trustRequired || trustExecutableContent,
					installedAt: now,
				},
				false
			);
			const locatorRef = this.getMachineSourceLocator(materialized.source);
			if (locatorRef && materialized.machineSourceLocation) {
				await this.storeLocalSourceLocation(locatorRef, materialized.machineSourceLocation);
			}
			return this.readInstalledPlugin(configurationRoot, inspected.manifest.id);
		} finally {
			await materialized.cleanup?.();
		}
	}

	async list(configurationRepository: URI): Promise<readonly IInstalledPluginPackage[]> {
		const configurationRoot = this.resolveConfigurationRepository(configurationRepository);
		const pluginsRoot = join(configurationRoot, PLUGINS_DIRECTORY);
		if (!await this.pathExists(pluginsRoot)) {
			return [];
		}
		const entries = await fs.readdir(pluginsRoot, { withFileTypes: true });
		const ids = entries
			.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
			.map(entry => entry.name)
			.sort();
		return Promise.all(ids.map(id => this.readInstalledPlugin(configurationRoot, id)));
	}

	async setEnabled(
		configurationRepository: URI,
		pluginId: string,
		enabled: boolean,
	): Promise<IInstalledPluginPackage> {
		const configurationRoot = this.resolveConfigurationRepository(configurationRepository);
		const installed = await this.readInstalledPlugin(configurationRoot, pluginId);
		if (enabled && !installed.trusted) {
			throw new Error(`Plugin "${pluginId}" cannot be enabled until its current content is explicitly trusted.`);
		}
		const target = this.pluginPath(configurationRoot, pluginId);
		const record = await this.readInstallRecord(target);
		await this.writeInstallRecord(target, { ...record, enabled });
		return this.readInstalledPlugin(configurationRoot, pluginId);
	}

	async grantTrust(
		configurationRepository: URI,
		pluginId: string,
	): Promise<IInstalledPluginPackage> {
		const configurationRoot = this.resolveConfigurationRepository(configurationRepository);
		const installed = await this.readInstalledPlugin(configurationRoot, pluginId);
		const target = this.pluginPath(configurationRoot, pluginId);
		const record = await this.readInstallRecord(target);
		await this.writeInstallRecord(target, {
			...record,
			trustedContentHash: installed.currentContentHash,
		});
		return this.readInstalledPlugin(configurationRoot, pluginId);
	}

	async uninstall(configurationRepository: URI, pluginId: string): Promise<void> {
		const configurationRoot = this.resolveConfigurationRepository(configurationRepository);
		const installed = await this.readInstalledPlugin(configurationRoot, pluginId);
		await Promise.all([
			fs.rm(this.pluginPath(configurationRoot, pluginId), { recursive: true, force: true }),
			fs.rm(this.baselinePath(configurationRoot, pluginId), { recursive: true, force: true }),
		]);
		const locatorRef = this.getMachineSourceLocator(installed.source);
		if (locatorRef) {
			await this.deleteLocalSourceLocation(locatorRef);
		}
	}

	async checkUpdates(configurationRepository: URI): Promise<readonly IPluginPackageUpdate[]> {
		const configurationRoot = this.resolveConfigurationRepository(configurationRepository);
		const installedPlugins = await this.list(configurationRepository);
		const updates: IPluginPackageUpdate[] = [];
		for (const installed of installedPlugins) {
			const sourceRequest = await this.toUpdateSourceRequest(installed.source);
			if (!sourceRequest) {
				continue;
			}
			const materialized = await this.materialize(sourceRequest);
			try {
				const inspected = await this.inspectRoot(materialized.root);
				if (
					inspected.manifest.id !== installed.manifest.id ||
					inspected.contentHash === installed.contentHash
				) {
					continue;
				}
				const baseline = this.baselinePath(configurationRoot, installed.manifest.id);
				const baselineFiles = await this.inspectFileHashes(baseline);
				updates.push({
					installed,
					preview: this.toPreview(inspected, materialized.source),
					changes: this.diffFiles(baselineFiles, inspected.fileHashes),
				});
			} finally {
				await materialized.cleanup?.();
			}
		}
		return updates.sort((left, right) =>
			left.installed.manifest.name.localeCompare(right.installed.manifest.name)
		);
	}

	async applyUpdate(
		configurationRepository: URI,
		pluginId: string,
		strategy: PluginUpdateStrategy,
		expectedContentHash: string,
		trustExecutableContent: boolean,
	): Promise<IPluginUpdateResult> {
		const configurationRoot = this.resolveConfigurationRepository(configurationRepository);
		const installed = await this.readInstalledPlugin(configurationRoot, pluginId);
		const sourceRequest = await this.toUpdateSourceRequest(installed.source);
		if (!sourceRequest) {
			throw new Error(`Plugin "${pluginId}" has no update source.`);
		}
		const materialized = await this.materialize(sourceRequest);
		try {
			const inspected = await this.inspectRoot(materialized.root);
			if (inspected.manifest.id !== pluginId) {
				throw new Error('The update package ID does not match the installed Plugin.');
			}
			if (inspected.contentHash === installed.contentHash) {
				throw new Error(`Plugin "${pluginId}" has no available update.`);
			}
			this.assertExpectedPreview(inspected, expectedContentHash);
			let forkedPluginId: string | undefined;
			if (strategy === 'fork') {
				forkedPluginId = await this.forkInstalledPlugin(configurationRoot, installed);
				return { installed, forkedPluginId };
			}
			if (strategy === 'merge') {
				const result = await this.mergeUpdate(
					configurationRoot,
					installed,
					materialized,
					inspected,
					trustExecutableContent
				);
				return { ...result, forkedPluginId };
			}
			await this.applyReplacementUpdate(
				configurationRoot,
				installed,
				materialized,
				inspected,
				trustExecutableContent
			);
			return {
				installed: await this.readInstalledPlugin(configurationRoot, pluginId),
				forkedPluginId,
			};
		} finally {
			await materialized.cleanup?.();
		}
	}

	private async applyReplacementUpdate(
		configurationRoot: string,
		installed: IInstalledPluginPackage,
		materialized: IMaterializedPlugin,
		inspected: IInspectedPlugin,
		trustExecutableContent: boolean,
	): Promise<void> {
		await this.replaceInstallation(
			configurationRoot,
			installed.resource.fsPath,
			materialized.root,
			{
				schemaVersion: INSTALL_RECORD_SCHEMA_VERSION,
				source: this.updatedSource(installed.source, materialized.source),
				contentHash: inspected.contentHash,
				trustedContentHash: trustExecutableContent || !inspected.trustRequired
					? inspected.contentHash
					: undefined,
				enabled: installed.enabled && (!inspected.trustRequired || trustExecutableContent),
				installedAt: installed.installedAt,
				updatedAt: Date.now(),
			},
			true
		);
	}

	private async mergeUpdate(
		configurationRoot: string,
		installed: IInstalledPluginPackage,
		materialized: IMaterializedPlugin,
		inspected: IInspectedPlugin,
		trustExecutableContent: boolean,
	): Promise<IPluginUpdateResult> {
		const baseline = this.baselinePath(configurationRoot, installed.manifest.id);
		const temporary = `${installed.resource.fsPath}.merge-${randomUUID()}`;
		await this.copyPackage(installed.resource.fsPath, temporary);
		try {
			const [baseFiles, currentFiles] = await Promise.all([
				this.inspectFileHashes(baseline),
				this.inspectFileHashes(temporary),
			]);
			const conflicts: string[] = [];
			const paths = new Set([...baseFiles.keys(), ...currentFiles.keys(), ...inspected.fileHashes.keys()]);
			for (const path of [...paths].sort()) {
				const base = baseFiles.get(path);
				const current = currentFiles.get(path);
				const incoming = inspected.fileHashes.get(path);
				if (current === incoming || incoming === base) {
					continue;
				}
				if (current === base) {
					await this.applyIncomingFile(materialized.root, temporary, path, incoming !== undefined);
					continue;
				}
				conflicts.push(path);
			}
			if (conflicts.length > 0) {
				return { installed, conflicts };
			}
			const merged = await this.inspectRoot(temporary);
			const record: IPluginInstallRecord = {
				schemaVersion: INSTALL_RECORD_SCHEMA_VERSION,
				source: this.updatedSource(installed.source, materialized.source),
				contentHash: inspected.contentHash,
				trustedContentHash: trustExecutableContent || !merged.trustRequired
					? merged.contentHash
					: undefined,
				enabled: installed.enabled && (!merged.trustRequired || trustExecutableContent),
				installedAt: installed.installedAt,
				updatedAt: Date.now(),
			};
			await this.replaceInstallation(
				configurationRoot,
				installed.resource.fsPath,
				temporary,
				record,
				true,
				materialized.root,
				merged.contentHash
			);
			return { installed: await this.readInstalledPlugin(configurationRoot, installed.manifest.id) };
		} finally {
			await fs.rm(temporary, { recursive: true, force: true });
		}
	}

	private async forkInstalledPlugin(
		configurationRoot: string,
		installed: IInstalledPluginPackage,
	): Promise<string> {
		const forkId = `${installed.manifest.id}-fork-${installed.currentContentHash.slice(0, 8)}`;
		const target = this.pluginPath(configurationRoot, forkId);
		if (await this.pathExists(target)) {
			throw new Error(`Fork Plugin "${forkId}" already exists.`);
		}
		const temporary = `${target}.install-${randomUUID()}`;
		await this.copyPackage(installed.resource.fsPath, temporary);
		try {
			const manifestPath = join(temporary, PLUGIN_MANIFEST_FILE);
			const manifest = parsePluginPackageManifest(await fs.readFile(manifestPath, 'utf8'));
			await fs.writeFile(manifestPath, `${JSON.stringify({
				...manifest,
				id: forkId,
				name: `${manifest.name} (Fork)`,
			}, null, '\t')}\n`);
			const inspected = await this.inspectRoot(temporary);
			await this.replaceInstallation(
				configurationRoot,
				target,
				temporary,
				{
					schemaVersion: INSTALL_RECORD_SCHEMA_VERSION,
					source: {
						type: 'fork',
						pluginId: installed.manifest.id,
						contentHash: installed.currentContentHash,
					},
					contentHash: inspected.contentHash,
					trustedContentHash: installed.trusted ? inspected.contentHash : undefined,
					enabled: false,
					installedAt: Date.now(),
				},
				false
			);
			return forkId;
		} finally {
			await fs.rm(temporary, { recursive: true, force: true });
		}
	}

	private async replaceInstallation(
		configurationRoot: string,
		target: string,
		source: string,
		record: IPluginInstallRecord,
		replaceExisting: boolean,
		baselineSource = source,
		expectedWorkingHash = record.contentHash,
	): Promise<void> {
		const pluginsRoot = join(configurationRoot, PLUGINS_DIRECTORY);
		const baseline = this.baselinePath(configurationRoot, basename(target));
		const temporaryTarget = `${target}.install-${randomUUID()}`;
		const temporaryBaseline = `${baseline}.install-${randomUUID()}`;
		const targetBackup = `${target}.backup-${randomUUID()}`;
		const baselineBackup = `${baseline}.backup-${randomUUID()}`;
		await fs.mkdir(join(pluginsRoot, BASELINES_DIRECTORY), { recursive: true });
		try {
			await Promise.all([
				this.copyPackage(source, temporaryTarget),
				this.copyPackage(baselineSource, temporaryBaseline),
			]);
			const [copiedTarget, copiedBaseline] = await Promise.all([
				this.inspectRoot(temporaryTarget),
				this.inspectRoot(temporaryBaseline),
			]);
			if (
				copiedTarget.contentHash !== expectedWorkingHash ||
				copiedBaseline.contentHash !== record.contentHash
			) {
				throw new Error('Plugin content changed while the immutable snapshot was being copied.');
			}
			await this.writeInstallRecord(temporaryTarget, record);
			if (replaceExisting) {
				if (await this.pathExists(target)) {
					await fs.rename(target, targetBackup);
				}
				if (await this.pathExists(baseline)) {
					await fs.rename(baseline, baselineBackup);
				}
			}
			await fs.rename(temporaryTarget, target);
			try {
				await fs.rename(temporaryBaseline, baseline);
			} catch (error) {
				await fs.rm(target, { recursive: true, force: true });
				if (await this.pathExists(targetBackup)) {
					await fs.rename(targetBackup, target);
				}
				throw error;
			}
			await Promise.all([
				fs.rm(targetBackup, { recursive: true, force: true }),
				fs.rm(baselineBackup, { recursive: true, force: true }),
			]);
		} catch (error) {
			await Promise.all([
				fs.rm(temporaryTarget, { recursive: true, force: true }),
				fs.rm(temporaryBaseline, { recursive: true, force: true }),
			]);
			if (replaceExisting) {
				if (!await this.pathExists(target) && await this.pathExists(targetBackup)) {
					await fs.rename(targetBackup, target);
				}
				if (!await this.pathExists(baseline) && await this.pathExists(baselineBackup)) {
					await fs.rename(baselineBackup, baseline);
				}
			}
			throw error;
		}
	}

	private async readInstalledPlugin(
		configurationRoot: string,
		pluginId: string,
	): Promise<IInstalledPluginPackage> {
		this.assertPluginId(pluginId);
		const target = this.pluginPath(configurationRoot, pluginId);
		const [record, inspected] = await Promise.all([
			this.readInstallRecord(target),
			this.inspectRoot(target),
		]);
		if (inspected.manifest.id !== pluginId) {
			throw new Error(`Installed Plugin directory "${pluginId}" does not match its manifest ID.`);
		}
		return {
			manifest: inspected.manifest,
			source: record.source,
			contentHash: record.contentHash,
			currentContentHash: inspected.contentHash,
			enabled: record.enabled,
			trusted: record.trustedContentHash === inspected.contentHash,
			installedAt: record.installedAt,
			updatedAt: record.updatedAt,
			localModified: inspected.contentHash !== record.contentHash,
			resource: URI.file(target),
		};
	}

	private async materialize(source: IPluginSourceRequest): Promise<IMaterializedPlugin> {
		if (source.type === 'local') {
			if (source.location.scheme !== Schemas.file) {
				throw new Error('Local Plugin sources must use file resources.');
			}
			const root = resolve(source.location.fsPath);
			const stat = await fs.lstat(root);
			if (!stat.isDirectory() || stat.isSymbolicLink()) {
				throw new Error('Local Plugin source must be a real directory.');
			}
			return {
				root,
				machineSourceLocation: root,
				source: {
					type: 'local',
					label: basename(root),
					locatorRef: `local_${randomUUID().replaceAll('-', '')}`,
				},
			};
		}
		this.assertGitSource(source.url, source.revision);
		const localGitSource = isAbsolute(source.url) ? resolve(source.url) : undefined;
		const root = await fs.mkdtemp(join(tmpdir(), 'repobud-plugin-'));
		try {
			await this.runGit(['clone', '--quiet', '--no-checkout', '--', source.url, root]);
			await this.runGit(['-C', root, 'checkout', '--quiet', '--detach', source.revision]);
			const { stdout: index } = await this.runGit(['-C', root, 'ls-files', '--stage']);
			if (index.split(/\r?\n/).some(line => line.startsWith('160000 '))) {
				throw new Error('Git Plugin sources containing submodules are not supported.');
			}
			const { stdout } = await this.runGit(['-C', root, 'rev-parse', 'HEAD']);
			return {
				root,
				source: localGitSource
					? {
						type: 'git',
						locationType: 'local',
						label: basename(localGitSource),
						locatorRef: `local_${randomUUID().replaceAll('-', '')}`,
						requestedRevision: source.revision,
						revision: stdout.trim(),
					}
					: {
						type: 'git',
						locationType: 'remote',
						url: source.url,
						requestedRevision: source.revision,
						revision: stdout.trim(),
					},
				machineSourceLocation: localGitSource,
				cleanup: () => fs.rm(root, { recursive: true, force: true }),
			};
		} catch (error) {
			await fs.rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	private async inspectRoot(root: string): Promise<IInspectedPlugin> {
		const manifestPath = join(root, PLUGIN_MANIFEST_FILE);
		const manifest = parsePluginPackageManifest(await fs.readFile(manifestPath, 'utf8'));
		const fileHashes = await this.inspectFileHashes(root);
		const files = [...fileHashes.keys()].sort();
		for (const skill of manifest.skills) {
			const skillPath = this.resolvePackagePath(root, skill);
			const stat = await fs.lstat(skillPath);
			if (!stat.isDirectory() || !await this.pathExists(join(skillPath, 'SKILL.md'))) {
				throw new Error(`Plugin Skill "${skill}" must be a directory containing SKILL.md.`);
			}
		}
		for (const integration of manifest.integrations) {
			const stat = await fs.lstat(this.resolvePackagePath(root, integration));
			if (!stat.isFile() || !integration.endsWith('.json')) {
				throw new Error(`Plugin Integration "${integration}" must be a JSON file.`);
			}
		}
		for (const script of manifest.scripts) {
			const stat = await fs.lstat(this.resolvePackagePath(root, script));
			if (!stat.isFile()) {
				throw new Error(`Plugin script "${script}" must be a file.`);
			}
		}
		const declaredScripts = new Set(manifest.scripts);
		for (const file of files) {
			const stat = await fs.stat(join(root, file));
			if ((stat.mode & 0o111) !== 0 && !declaredScripts.has(file)) {
				throw new Error(`Executable Plugin file "${file}" must be declared in scripts.`);
			}
		}
		return {
			manifest,
			contentHash: await this.hashFiles(root, files),
			files,
			fileHashes,
			trustRequired: manifest.scripts.length > 0,
		};
	}

	private async inspectFileHashes(root: string): Promise<ReadonlyMap<string, string>> {
		const result = new Map<string, string>();
		const caseFoldedPaths = new Map<string, string>();
		const visit = async (directory: string): Promise<void> => {
			const entries = await fs.readdir(directory, { withFileTypes: true });
			entries.sort((left, right) => left.name.localeCompare(right.name));
			for (const entry of entries) {
				if (
					entry.name === '.git' ||
					entry.name === PLUGIN_INSTALL_RECORD_FILE ||
					entry.name === BASELINES_DIRECTORY
				) {
					continue;
				}
				const path = join(directory, entry.name);
				const relativePath = relative(root, path).split(sep).join('/');
				const foldedPath = relativePath.toLocaleLowerCase('en-US');
				const collision = caseFoldedPaths.get(foldedPath);
				if (collision && collision !== relativePath) {
					throw new Error(
						`Plugin package paths collide on a case-insensitive filesystem: ${collision}, ${relativePath}`
					);
				}
				caseFoldedPaths.set(foldedPath, relativePath);
				const stat = await fs.lstat(path);
				if (stat.isSymbolicLink()) {
					throw new Error(`Plugin packages cannot contain symbolic links: ${relativePath}`);
				}
				if (stat.isDirectory()) {
					await visit(path);
				} else if (stat.isFile()) {
					result.set(
						relativePath,
						createHash('sha256')
							.update(`${stat.mode & 0o777}\0`)
							.update(await fs.readFile(path))
							.digest('hex')
					);
				} else {
					throw new Error(`Unsupported Plugin package entry: ${relativePath}`);
				}
			}
		};
		await visit(root);
		return result;
	}

	private async hashFiles(root: string, files: readonly string[]): Promise<string> {
		const hash = createHash('sha256');
		for (const file of files) {
			const path = join(root, file);
			const stat = await fs.stat(path);
			hash.update(`file\0${file}\0${stat.mode & 0o777}\0`);
			hash.update(await fs.readFile(path));
			hash.update('\0');
		}
		return hash.digest('hex');
	}

	private diffFiles(
		baseline: ReadonlyMap<string, string>,
		incoming: ReadonlyMap<string, string>,
	): IPluginFileChange[] {
		const changes: IPluginFileChange[] = [];
		for (const path of new Set([...baseline.keys(), ...incoming.keys()])) {
			const before = baseline.get(path);
			const after = incoming.get(path);
			if (before === after) {
				continue;
			}
			changes.push({
				path,
				kind: this.toFileChangeKind(before, after),
			});
		}
		return changes.sort((left, right) => left.path.localeCompare(right.path));
	}

	private toFileChangeKind(
		before: string | undefined,
		after: string | undefined,
	): IPluginFileChange['kind'] {
		if (before === undefined) {
			return 'added';
		}
		if (after === undefined) {
			return 'deleted';
		}
		return 'modified';
	}

	private async applyIncomingFile(
		incomingRoot: string,
		targetRoot: string,
		relativePath: string,
		present: boolean,
	): Promise<void> {
		const target = join(targetRoot, relativePath);
		if (!present) {
			await fs.rm(target, { recursive: true, force: true });
			return;
		}
		await fs.mkdir(dirname(target), { recursive: true });
		await fs.copyFile(join(incomingRoot, relativePath), target);
		const stat = await fs.stat(join(incomingRoot, relativePath));
		await fs.chmod(target, stat.mode & 0o777);
	}

	private async copyPackage(source: string, target: string): Promise<void> {
		const sourceRoot = resolve(source);
		await fs.cp(sourceRoot, target, {
			recursive: true,
			errorOnExist: true,
			force: false,
			filter: path => {
				const relativePath = relative(sourceRoot, path).split(sep).join('/');
				return relativePath !== '.git' &&
					!relativePath.startsWith('.git/') &&
					relativePath !== PLUGIN_INSTALL_RECORD_FILE &&
					relativePath !== BASELINES_DIRECTORY &&
					!relativePath.startsWith(`${BASELINES_DIRECTORY}/`);
			},
		});
	}

	private async readInstallRecord(root: string): Promise<IPluginInstallRecord> {
		let value: unknown;
		try {
			value = JSON.parse(await fs.readFile(join(root, PLUGIN_INSTALL_RECORD_FILE), 'utf8'));
		} catch (error) {
			throw new Error(`Cannot read Plugin installation record: ${this.toErrorMessage(error)}`);
		}
		if (!value || typeof value !== 'object') {
			throw new Error('Plugin installation record must be an object.');
		}
		const record = value as Partial<IPluginInstallRecord>;
		if (
			record.schemaVersion !== INSTALL_RECORD_SCHEMA_VERSION ||
			!record.source ||
			typeof record.contentHash !== 'string' ||
			(record.trustedContentHash !== undefined && typeof record.trustedContentHash !== 'string') ||
			typeof record.enabled !== 'boolean' ||
			typeof record.installedAt !== 'number' ||
			(record.updatedAt !== undefined && typeof record.updatedAt !== 'number')
		) {
			throw new Error('Plugin installation record is invalid.');
		}
		this.validateResolvedSource(record.source);
		return record as IPluginInstallRecord;
	}

	private async writeInstallRecord(root: string, record: IPluginInstallRecord): Promise<void> {
		await fs.writeFile(
			join(root, PLUGIN_INSTALL_RECORD_FILE),
			`${JSON.stringify(record, null, '\t')}\n`,
			{ mode: 0o600 }
		);
	}

	private validateResolvedSource(source: IResolvedPluginSource): void {
		if (source.type === 'local') {
			if (
				typeof source.label !== 'string' ||
				!source.label ||
				source.label.length > 255 ||
				/[\r\n]/.test(source.label) ||
				!/^local_[a-f0-9]{32}$/.test(source.locatorRef)
			) {
				throw new Error('Local Plugin source reference is invalid.');
			}
			return;
		}
		if (source.type === 'git') {
			if (source.locationType === 'local') {
				if (
					!source.label ||
					source.label.length > 255 ||
					/[\r\n/\\]/.test(source.label) ||
					!/^local_[a-f0-9]{32}$/.test(source.locatorRef)
				) {
					throw new Error('Local Git Plugin source reference is invalid.');
				}
			} else if (source.locationType === 'remote') {
				this.assertGitSource(source.url, source.requestedRevision);
			} else {
				throw new Error('Git Plugin source location type is invalid.');
			}
			if (!/^[0-9a-f]{40}$/.test(source.revision)) {
				throw new Error('Resolved Git Plugin revision must be a full commit hash.');
			}
			return;
		}
		this.assertPluginId(source.pluginId);
		if (!/^[0-9a-f]{64}$/.test(source.contentHash)) {
			throw new Error('Fork Plugin source content hash is invalid.');
		}
	}

	private assertExpectedPreview(
		inspected: IInspectedPlugin,
		expectedContentHash: string,
	): void {
		if (inspected.contentHash !== expectedContentHash) {
			throw new Error('Plugin content changed after preview. Review the package again before continuing.');
		}
	}

	private toPreview(
		inspected: IInspectedPlugin,
		source: IResolvedPluginSource,
	): IPluginPackagePreview {
		return {
			manifest: inspected.manifest,
			source,
			contentHash: inspected.contentHash,
			files: inspected.files,
			trustRequired: inspected.trustRequired,
		};
	}

	private async toUpdateSourceRequest(source: IResolvedPluginSource): Promise<IPluginSourceRequest | undefined> {
		if (source.type === 'local') {
			await this.loadLocalSourceRegistry();
			const location = this.localSourceLocations.get(source.locatorRef);
			return location ? { type: 'local', location: URI.file(location) } : undefined;
		}
		if (source.type === 'git') {
			if (source.locationType === 'local') {
				await this.loadLocalSourceRegistry();
				const location = this.localSourceLocations.get(source.locatorRef);
				return location
					? { type: 'git', url: location, revision: source.requestedRevision }
					: undefined;
			}
			return { type: 'git', url: source.url, revision: source.requestedRevision };
		}
		return undefined;
	}

	private getMachineSourceLocator(source: IResolvedPluginSource): string | undefined {
		if (source.type === 'local') {
			return source.locatorRef;
		}
		if (source.type === 'git' && source.locationType === 'local') {
			return source.locatorRef;
		}
		return undefined;
	}

	private updatedSource(
		installed: IResolvedPluginSource,
		incoming: IResolvedPluginSource,
	): IResolvedPluginSource {
		if (installed.type === 'local') {
			return installed;
		}
		if (installed.type === 'git' && installed.locationType === 'local') {
			if (incoming.type !== 'git') {
				throw new Error('A Git Plugin update must retain its Git source type.');
			}
			return {
				...installed,
				revision: incoming.revision,
			};
		}
		return incoming;
	}

	private async storeLocalSourceLocation(locatorRef: string, location: string): Promise<void> {
		await this.loadLocalSourceRegistry();
		this.localSourceLocations.set(locatorRef, location);
		await this.writeLocalSourceRegistry();
	}

	private async deleteLocalSourceLocation(locatorRef: string): Promise<void> {
		await this.loadLocalSourceRegistry();
		this.localSourceLocations.delete(locatorRef);
		await this.writeLocalSourceRegistry();
	}

	private async loadLocalSourceRegistry(): Promise<void> {
		if (this.localSourceRegistryLoaded) {
			return;
		}
		this.localSourceRegistryLoaded = true;
		try {
			const raw = await fs.readFile(this.localSourceRegistryPath, 'utf8');
			const value = JSON.parse(raw) as Partial<ILocalSourceRegistry>;
			if (
				value.schemaVersion !== LOCAL_SOURCE_REGISTRY_SCHEMA_VERSION ||
				!value.locations ||
				typeof value.locations !== 'object'
			) {
				return;
			}
			for (const [locatorRef, location] of Object.entries(value.locations)) {
				if (/^local_[a-f0-9]{32}$/.test(locatorRef) && typeof location === 'string' && isAbsolute(location)) {
					this.localSourceLocations.set(locatorRef, location);
				}
			}
		} catch (error) {
			if (!this.isFileSystemError(error, 'ENOENT')) {
				throw new Error(`Cannot read the machine-local Plugin source registry: ${this.toErrorMessage(error)}`);
			}
		}
	}

	private async writeLocalSourceRegistry(): Promise<void> {
		const target = this.localSourceRegistryPath;
		const temporary = `${target}.tmp-${randomUUID()}`;
		await fs.mkdir(dirname(target), { recursive: true });
		await fs.writeFile(temporary, `${JSON.stringify({
			schemaVersion: LOCAL_SOURCE_REGISTRY_SCHEMA_VERSION,
			locations: Object.fromEntries(
				[...this.localSourceLocations.entries()].sort(([left], [right]) => left.localeCompare(right))
			),
		} satisfies ILocalSourceRegistry, null, '\t')}\n`, { mode: 0o600 });
		await fs.rename(temporary, target);
	}

	private get localSourceRegistryPath(): string {
		return join(
			this.environmentMainService.userDataPath,
			'repobud',
			'plugin-local-sources.json'
		);
	}

	private resolveConfigurationRepository(repository: URI): string {
		if (repository.scheme !== Schemas.file) {
			throw new Error('Plugin management requires a local configuration repository.');
		}
		const path = resolve(repository.fsPath);
		if (!isAbsolute(path)) {
			throw new Error('Configuration repository path must be absolute.');
		}
		return path;
	}

	private pluginPath(configurationRoot: string, pluginId: string): string {
		this.assertPluginId(pluginId);
		return join(configurationRoot, PLUGINS_DIRECTORY, pluginId);
	}

	private baselinePath(configurationRoot: string, pluginId: string): string {
		this.assertPluginId(pluginId);
		return join(configurationRoot, PLUGINS_DIRECTORY, BASELINES_DIRECTORY, pluginId);
	}

	private resolvePackagePath(root: string, relativePath: string): string {
		const path = resolve(root, relativePath);
		const rootWithSeparator = root.endsWith(sep) ? root : `${root}${sep}`;
		if (!path.startsWith(rootWithSeparator)) {
			throw new Error(`Plugin path escapes the package root: ${relativePath}`);
		}
		return path;
	}

	private assertPluginId(pluginId: string): void {
		if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(pluginId)) {
			throw new Error(`Invalid Plugin ID "${pluginId}".`);
		}
	}

	private assertGitSource(url: string, revision: string): void {
		if (!url.trim() || url.startsWith('-') || !revision.trim() || revision.startsWith('-')) {
			throw new Error('Git Plugin source and revision must be non-empty safe arguments.');
		}
		try {
			const parsed = new URL(url);
			if (parsed.username || parsed.password || parsed.search || parsed.hash) {
				throw new Error('Git Plugin URLs must not contain embedded credentials.');
			}
		} catch (error) {
			if (error instanceof Error && error.message.includes('embedded credentials')) {
				throw error;
			}
			if (!isAbsolute(url) && !/^[^@\s]+@[^:\s]+:.+/.test(url)) {
				throw new Error('Git Plugin source must be an absolute path or a supported Git URL.');
			}
		}
	}

	private async runGit(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
		try {
			return await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
				encoding: 'utf8',
				env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
				maxBuffer: 4 * 1024 * 1024,
				timeout: 60_000,
			});
		} catch (error) {
			throw new Error(`Git Plugin source failed: ${this.toErrorMessage(error)}`);
		}
	}

	private async pathExists(path: string): Promise<boolean> {
		try {
			await fs.lstat(path);
			return true;
		} catch (error) {
			if (this.isFileSystemError(error, 'ENOENT')) {
				return false;
			}
			throw error;
		}
	}

	private toErrorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	private isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
		return error instanceof Error &&
			(error as NodeJS.ErrnoException).code === code;
	}
}
