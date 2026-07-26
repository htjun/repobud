/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { Schemas } from '../../../base/common/network.js';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from '../../../base/common/path.js';
import {
	IRepositoryContextSkillProjectionService,
	ISkillProjectionManifest,
	ISkillProjectionRequest,
	ISkillProjectionResult,
	SkillProjectionStrategy,
} from '../common/skillProjection.js';

interface IValidatedProjectionPaths {
	readonly source: string;
	readonly target: string;
	readonly overlay?: string;
}

export class RepositoryContextSkillProjectionMainService implements IRepositoryContextSkillProjectionService {

	declare readonly _serviceBrand: undefined;

	async inspect(request: ISkillProjectionRequest): Promise<ISkillProjectionResult> {
		let paths: IValidatedProjectionPaths;
		try {
			paths = await this.validateRequest(request);
		} catch (error) {
			return {
				state: 'unsupported',
				detail: this.toErrorMessage(error),
			};
		}

		if (paths.source === paths.target) {
			return { state: 'linked', mode: 'direct' };
		}

		let targetStat;
		try {
			targetStat = await fs.lstat(paths.target);
		} catch (error) {
			if (this.isFileSystemError(error, 'ENOENT')) {
				return { state: 'missing' };
			}
			return {
				state: 'unsupported',
				detail: `Cannot inspect the projection target: ${this.toErrorMessage(error)}`,
			};
		}

		if (targetStat.isSymbolicLink()) {
			try {
				const [sourceRealPath, targetRealPath] = await Promise.all([
					fs.realpath(paths.source),
					fs.realpath(paths.target),
				]);
				if (sourceRealPath === targetRealPath) {
					return { state: 'linked', mode: 'symlink' };
				}
			} catch {
				// A dangling or unreadable link is drifted, not a valid projection.
			}
			return {
				state: 'modified',
				mode: 'symlink',
				detail: 'The projection link points to a different source.',
			};
		}

		if (!targetStat.isDirectory()) {
			return {
				state: 'modified',
				detail: 'The projection target is not a Skill directory.',
			};
		}

		const manifest = request.manifest;
		if (!manifest || !this.matchesManifest(manifest, request, paths)) {
			return {
				state: 'modified',
				mode: 'managed-copy',
				detail: 'The target is not tracked by the current canonical Skill.',
			};
		}

		const [sourceHash, outputHash] = await Promise.all([
			this.hashProjectionInput(paths),
			this.hashDirectory(paths.target),
		]);
		if (outputHash !== manifest.outputHash) {
			return {
				state: 'modified',
				mode: 'managed-copy',
				manifest,
				sourceHash,
				outputHash,
				detail: 'The projected copy was modified outside Repository Context Workbench.',
			};
		}
		if (sourceHash !== manifest.sourceHash) {
			return {
				state: 'outdated',
				mode: 'managed-copy',
				manifest,
				sourceHash,
				outputHash,
				detail: 'The canonical Skill changed after this copy was projected.',
			};
		}

		return {
			state: 'copied',
			mode: 'managed-copy',
			manifest,
			sourceHash,
			outputHash,
		};
	}

	async project(request: ISkillProjectionRequest): Promise<ISkillProjectionResult> {
		const inspection = await this.inspect(request);
		if (inspection.state === 'linked' || inspection.state === 'copied') {
			return inspection;
		}
		if (inspection.state !== 'missing') {
			throw new Error(
				`Projection is ${inspection.state}. Import changes or restore the projection before replacing it.`
			);
		}

		const paths = await this.validateRequest(request);
		await fs.mkdir(dirname(paths.target), { recursive: true });
		return this.createProjection(request, paths, request.strategy ?? 'prefer-link');
	}

	async importChanges(request: ISkillProjectionRequest): Promise<ISkillProjectionResult> {
		if (request.overlay) {
			throw new Error('Client-specific overlay projections cannot be imported into shared canonical content.');
		}
		const inspection = await this.inspect(request);
		if (inspection.state === 'linked') {
			return inspection;
		}
		if (inspection.state !== 'modified' && inspection.state !== 'outdated' && inspection.state !== 'copied') {
			throw new Error(`Cannot import a ${inspection.state} projection.`);
		}

		const paths = await this.validateRequest(request);
		const targetStat = await fs.lstat(paths.target);
		if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
			throw new Error('Only a managed Skill directory can be imported.');
		}

		const temporarySource = `${paths.source}.repository-context-import-${randomUUID()}`;
		const backupSource = `${paths.source}.repository-context-backup-${randomUUID()}`;
		await fs.cp(paths.target, temporarySource, { recursive: true, errorOnExist: true, force: false });
		try {
			await this.validateSkillDirectory(temporarySource);
			await fs.rename(paths.source, backupSource);
			try {
				await fs.rename(temporarySource, paths.source);
			} catch (error) {
				await fs.rename(backupSource, paths.source);
				throw error;
			}
			await fs.rm(backupSource, { recursive: true, force: true });
		} catch (error) {
			await fs.rm(temporarySource, { recursive: true, force: true });
			throw error;
		}

		await fs.rm(paths.target, { recursive: true, force: true });
		return this.createProjection(request, paths, request.strategy ?? 'prefer-link');
	}

	async restore(request: ISkillProjectionRequest): Promise<ISkillProjectionResult> {
		const paths = await this.validateRequest(request);
		if (paths.source === paths.target) {
			return { state: 'linked', mode: 'direct' };
		}

		await fs.rm(paths.target, { recursive: true, force: true });
		await fs.mkdir(dirname(paths.target), { recursive: true });
		return this.createProjection(request, paths, request.strategy ?? 'prefer-link');
	}

	private async createProjection(
		request: ISkillProjectionRequest,
		paths: IValidatedProjectionPaths,
		strategy: SkillProjectionStrategy,
	): Promise<ISkillProjectionResult> {
		if (strategy === 'prefer-link' && !paths.overlay) {
			try {
				await fs.symlink(paths.source, paths.target, 'dir');
				return { state: 'linked', mode: 'symlink' };
			} catch (error) {
				if (await this.pathExists(paths.target)) {
					throw error;
				}
			}
		}

		try {
			await this.copyProjectionInput(paths);
			const [sourceHash, outputHash] = await Promise.all([
				this.hashProjectionInput(paths),
				this.hashDirectory(paths.target),
			]);
			const manifest: ISkillProjectionManifest = {
				version: 1,
				client: request.client,
				skillId: request.skillId,
				mode: 'managed-copy',
				source: paths.source,
				target: paths.target,
				overlay: paths.overlay,
				sourceHash,
				outputHash,
			};
			return {
				state: 'copied',
				mode: 'managed-copy',
				manifest,
				sourceHash,
				outputHash,
			};
		} catch (error) {
			await fs.rm(paths.target, { recursive: true, force: true });
			throw error;
		}
	}

	private async validateRequest(request: ISkillProjectionRequest): Promise<IValidatedProjectionPaths> {
		if (!['codex', 'claude-code', 'cursor'].includes(request.client)) {
			throw new Error(`Unsupported projection client "${request.client}".`);
		}
		if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(request.skillId)) {
			throw new Error(`Unsupported Skill identifier "${request.skillId}".`);
		}
		if (request.source.scheme !== Schemas.file || request.target.scheme !== Schemas.file) {
			throw new Error('Skill projection currently supports local file resources only.');
		}

		const source = resolve(request.source.fsPath);
		const target = resolve(request.target.fsPath);
		if (!isAbsolute(source) || !isAbsolute(target)) {
			throw new Error('Skill projection paths must be absolute.');
		}
		if (target === parse(target).root) {
			throw new Error('The projection target cannot be a filesystem root.');
		}
		if (source !== target && this.isEqualOrParent(source, target)) {
			throw new Error('The canonical source cannot contain its projection target.');
		}
		if (source !== target && this.isEqualOrParent(target, source)) {
			throw new Error('The projection target cannot contain its canonical source.');
		}
		if (basename(source) !== request.skillId || basename(target) !== request.skillId) {
			throw new Error('Skill identifiers must match both source and target directory names.');
		}

		await this.validateSkillDirectory(source);

		let overlay: string | undefined;
		if (request.overlay) {
			if (request.overlay.scheme !== Schemas.file) {
				throw new Error('Skill projection overlays currently support local file resources only.');
			}
			overlay = resolve(request.overlay.fsPath);
			const overlayRoot = join(source, '.repository-context', 'overlays');
			if (!this.isEqualOrParent(overlayRoot, overlay) || basename(overlay) !== `${request.client}.yaml`) {
				throw new Error('A client overlay must use the canonical .repository-context/overlays directory.');
			}
			const overlayStat = await fs.stat(overlay);
			if (!overlayStat.isFile()) {
				throw new Error('The client overlay is not a file.');
			}
		}
		return { source, target, overlay };
	}

	private async validateSkillDirectory(path: string): Promise<void> {
		let directoryStat;
		try {
			directoryStat = await fs.stat(path);
		} catch (error) {
			throw new Error(`Canonical Skill is missing: ${this.toErrorMessage(error)}`);
		}
		if (!directoryStat.isDirectory()) {
			throw new Error('Canonical Skill source is not a directory.');
		}

		const definitionPath = join(path, 'SKILL.md');
		let definitionStat;
		try {
			definitionStat = await fs.stat(definitionPath);
		} catch (error) {
			throw new Error(`Canonical Skill has no SKILL.md: ${this.toErrorMessage(error)}`);
		}
		if (!definitionStat.isFile()) {
			throw new Error('Canonical Skill SKILL.md is not a file.');
		}
	}

	private matchesManifest(
		manifest: ISkillProjectionManifest,
		request: ISkillProjectionRequest,
		paths: IValidatedProjectionPaths,
	): boolean {
		const sharesPortableTarget = !paths.overlay &&
			!manifest.overlay &&
			['codex', 'cursor'].includes(manifest.client) &&
			['codex', 'cursor'].includes(request.client);
		return manifest.version === 1 &&
			(manifest.client === request.client || sharesPortableTarget) &&
			manifest.skillId === request.skillId &&
			manifest.mode === 'managed-copy' &&
			manifest.source === paths.source &&
			manifest.target === paths.target &&
			manifest.overlay === paths.overlay;
	}

	private async copyProjectionInput(paths: IValidatedProjectionPaths): Promise<void> {
		const overlayDirectory = join(paths.source, '.repository-context', 'overlays');
		await fs.cp(paths.source, paths.target, {
			recursive: true,
			errorOnExist: true,
			force: false,
			filter: path => !this.isEqualOrParent(overlayDirectory, path),
		});
		if (paths.overlay) {
			const [definition, overlay] = await Promise.all([
				fs.readFile(join(paths.target, 'SKILL.md'), 'utf8'),
				fs.readFile(paths.overlay, 'utf8'),
			]);
			await fs.writeFile(
				join(paths.target, 'SKILL.md'),
				this.applyFrontmatterOverlay(definition, overlay),
				'utf8'
			);
		}
	}

	private applyFrontmatterOverlay(definition: string, overlay: string): string {
		const opening = definition.match(/^---\r?\n/);
		if (!opening) {
			throw new Error('Canonical SKILL.md has no YAML frontmatter.');
		}
		const remainder = definition.slice(opening[0].length);
		const closing = remainder.match(/\r?\n---(?:\r?\n|$)/);
		if (!closing || closing.index === undefined) {
			throw new Error('Canonical SKILL.md has no closing YAML frontmatter delimiter.');
		}
		const insertAt = opening[0].length + closing.index;
		return `${definition.slice(0, insertAt)}\n${overlay.trim()}\n${definition.slice(insertAt + 1)}`;
	}

	private async hashProjectionInput(paths: IValidatedProjectionPaths): Promise<string> {
		const sharedHash = await this.hashDirectory(
			paths.source,
			relativePath => !this.isEqualOrParent('.repository-context/overlays', relativePath)
		);
		if (!paths.overlay) {
			return sharedHash;
		}
		return createHash('sha256')
			.update(sharedHash)
			.update('\0overlay\0')
			.update(await fs.readFile(paths.overlay))
			.digest('hex');
	}

	private async hashDirectory(root: string, include: (relativePath: string) => boolean = () => true): Promise<string> {
		const hash = createHash('sha256');
		const visit = async (directory: string): Promise<void> => {
			const entries = await fs.readdir(directory, { withFileTypes: true });
			entries.sort((left, right) => left.name.localeCompare(right.name));
			for (const entry of entries) {
				const path = join(directory, entry.name);
				const relativePath = relative(root, path).split(sep).join('/');
				if (!include(relativePath)) {
					continue;
				}
				const stat = await fs.lstat(path);
				if (stat.isSymbolicLink()) {
					hash.update(`link\0${relativePath}\0${await fs.readlink(path)}\0`);
				} else if (stat.isDirectory()) {
					hash.update(`directory\0${relativePath}\0`);
					await visit(path);
				} else if (stat.isFile()) {
					hash.update(`file\0${relativePath}\0${stat.mode & 0o777}\0`);
					hash.update(await fs.readFile(path));
					hash.update('\0');
				} else {
					throw new Error(`Unsupported Skill entry "${relativePath}".`);
				}
			}
		};
		await visit(root);
		return hash.digest('hex');
	}

	private isEqualOrParent(parent: string, candidate: string): boolean {
		return candidate === parent || candidate.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
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

	private isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
		return error instanceof Error && 'code' in error && error.code === code;
	}

	private toErrorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
