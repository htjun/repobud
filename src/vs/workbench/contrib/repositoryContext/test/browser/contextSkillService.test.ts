/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { FileSystemProviderCapabilities } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import {
	IRepositoryContextSkillProjectionService,
	ISkillProjectionRequest,
	ISkillProjectionResult,
} from '../../../../../platform/repositoryContext/common/skillProjection.js';
import { InMemoryStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { CanonicalConfigurationService } from '../../browser/canonicalConfigurationService.js';
import { ContextSkillService } from '../../browser/contextSkillService.js';
import { createCanonicalConfiguration } from '../../common/canonicalConfiguration.js';
import { IContextPluginService } from '../../common/pluginManagement.js';
import { IRepositoryCatalogEntry, IRepositoryCatalogService } from '../../common/repositoryCatalog.js';

class AtomicInMemoryFileSystemProvider extends InMemoryFileSystemProvider {

	override get capabilities(): FileSystemProviderCapabilities {
		return super.capabilities | FileSystemProviderCapabilities.FileAtomicWrite;
	}
}

class TestRepositoryCatalogService implements IRepositoryCatalogService {

	declare readonly _serviceBrand: undefined;
	readonly onDidChange = Event.None;
	readonly entries: readonly IRepositoryCatalogEntry[] = [];

	constructor(readonly activeRepository: URI | undefined) { }

	async add(uri: URI): Promise<IRepositoryCatalogEntry> {
		return { uri, availability: 'ready' };
	}

	remove(): void { }
	async refresh(): Promise<void> { }
}

class TestSkillProjectionService implements IRepositoryContextSkillProjectionService {

	declare readonly _serviceBrand: undefined;
	readonly requests: ISkillProjectionRequest[] = [];
	readonly results = new Map<string, ISkillProjectionResult>();
	importCount = 0;
	restoreCount = 0;

	async inspect(request: ISkillProjectionRequest): Promise<ISkillProjectionResult> {
		this.requests.push(request);
		return this.results.get(request.target.toString()) ?? { state: 'missing' };
	}

	async project(request: ISkillProjectionRequest): Promise<ISkillProjectionResult> {
		const result: ISkillProjectionResult = {
			state: 'copied',
			mode: 'managed-copy',
			manifest: {
				version: 1,
				client: request.client,
				skillId: request.skillId,
				mode: 'managed-copy',
				source: request.source.fsPath,
				target: request.target.fsPath,
				overlay: request.overlay?.fsPath,
				sourceHash: 'a'.repeat(64),
				outputHash: 'a'.repeat(64),
			},
		};
		this.results.set(request.target.toString(), result);
		return result;
	}

	async importChanges(request: ISkillProjectionRequest): Promise<ISkillProjectionResult> {
		this.importCount++;
		return this.project(request);
	}

	async restore(request: ISkillProjectionRequest): Promise<ISkillProjectionResult> {
		this.restoreCount++;
		return this.project(request);
	}
}

suite('ContextSkillService', () => {

	const disposables = new DisposableStore();
	let fileService: FileService;
	let storageService: InMemoryStorageService;
	let activeRepository: URI;
	let globalRepository: URI;
	let catalogService: TestRepositoryCatalogService;
	let canonicalConfigurationService: CanonicalConfigurationService;
	let projectionService: TestSkillProjectionService;
	let pathService: IPathService;
	let skillService: ContextSkillService;
	const pluginService = {
		_serviceBrand: undefined,
		snapshot: {
			globalRepository: undefined,
			installed: [],
			updates: [],
			errors: [],
			loading: false,
		},
		onDidChange: Event.None,
	} as unknown as IContextPluginService;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		const provider = disposables.add(new AtomicInMemoryFileSystemProvider());
		disposables.add(fileService.registerProvider(Schemas.inMemory, provider));
		storageService = disposables.add(new InMemoryStorageService());
		activeRepository = URI.from({ scheme: Schemas.inMemory, path: '/project' });
		globalRepository = URI.from({ scheme: Schemas.inMemory, path: '/global' });
		await Promise.all([
			fileService.createFolder(joinPath(activeRepository, '.git')),
			fileService.createFolder(joinPath(globalRepository, '.git')),
		]);
		catalogService = new TestRepositoryCatalogService(activeRepository);
		projectionService = new TestSkillProjectionService();
		pathService = {
			userHome: () => URI.from({ scheme: Schemas.inMemory, path: '/home' }),
		} as unknown as IPathService;
		canonicalConfigurationService = disposables.add(new CanonicalConfigurationService(
			storageService,
			fileService,
			catalogService
		));
		await canonicalConfigurationService.adoptGlobalRepository(globalRepository);
	});

	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	async function writeSkill(root: URI, id: string, name: string, description?: string): Promise<void> {
		const directory = joinPath(root, id);
		await fileService.createFolder(directory);
		const frontmatter = [
			'---',
			`name: ${id}`,
			...(description ? [`description: ${description}`] : []),
			'---',
			'',
			`# ${name}`,
			'',
		].join('\n');
		await fileService.writeFile(joinPath(directory, 'SKILL.md'), VSBuffer.fromString(frontmatter));
	}

	test('resolves active-repository Skills and persists Inherit, On, and Off overrides', async () => {
		await Promise.all([
			writeSkill(joinPath(globalRepository, 'skills'), 'review', 'Review', 'Review changes.'),
			writeSkill(joinPath(activeRepository, '.repository-context', 'skills'), 'release', 'Release', 'Prepare releases.'),
		]);
		await canonicalConfigurationService.writeGlobalConfiguration({
			...createCanonicalConfiguration('global'),
			skills: { review: { activation: 'off' } },
		});
		await canonicalConfigurationService.writeRepositoryConfiguration(activeRepository, {
			...createCanonicalConfiguration('repository'),
			skills: {
				review: { activation: 'on' },
				release: { activation: 'off' },
			},
		});

		skillService = disposables.add(new ContextSkillService(
			fileService,
			catalogService,
			canonicalConfigurationService,
			projectionService,
			storageService,
			pathService,
			pluginService
		));
		await skillService.refresh();

		assert.strictEqual(skillService.snapshot.activeRepository?.toString(), activeRepository.toString());
		assert.deepStrictEqual(skillService.snapshot.sections.enabled.map(skill => skill.id), ['review']);
		assert.deepStrictEqual(skillService.snapshot.sections.available.map(skill => skill.id), ['release']);
		assert.deepStrictEqual(skillService.snapshot.sections.enabled[0].origins, ['global']);
		assert.deepStrictEqual(skillService.snapshot.sections.available[0].origins, ['repository']);

		await skillService.setRepositoryOverride('review', 'inherit');
		assert.deepStrictEqual(skillService.snapshot.sections.available.map(skill => skill.id), ['release', 'review']);
		const configuration = await canonicalConfigurationService.readRepositoryConfiguration(activeRepository);
		assert.strictEqual(configuration.skills.review, undefined);

		await skillService.setGlobalActivation('review', 'on');
		assert.strictEqual(skillService.snapshot.sections.enabled[0].activationSource, 'global');
		assert.strictEqual(
			(await canonicalConfigurationService.readGlobalConfiguration())?.skills.review.activation,
			'on'
		);

		await skillService.setRepositoryOverride('review', 'on');
		assert.strictEqual(skillService.snapshot.sections.enabled[0].repositoryOverride, 'on');

		await skillService.setRepositoryOverride('review', 'off');
		assert.strictEqual(skillService.snapshot.sections.available.find(skill => skill.id === 'review')?.repositoryOverride, 'off');
	});

	test('reports conflicting and invalid Skill definitions', async () => {
		await Promise.all([
			writeSkill(joinPath(globalRepository, 'skills'), 'review', 'Global Review', 'Review globally.'),
			writeSkill(joinPath(activeRepository, '.repository-context', 'skills'), 'review', 'Repository Review', 'Review locally.'),
			writeSkill(joinPath(activeRepository, '.repository-context', 'skills'), 'invalid', 'Invalid'),
		]);
		skillService = disposables.add(new ContextSkillService(
			fileService,
			catalogService,
			canonicalConfigurationService,
			projectionService,
			storageService,
			pathService,
			pluginService
		));
		await skillService.refresh();

		assert.deepStrictEqual(
			skillService.snapshot.sections.needsAttention.map(skill => skill.id),
			['invalid', 'review']
		);
		assert.deepStrictEqual(
			skillService.snapshot.sections.needsAttention.find(skill => skill.id === 'review')?.origins,
			['repository', 'global']
		);
		assert.match(
			skillService.snapshot.sections.needsAttention.find(skill => skill.id === 'invalid')?.issue ?? '',
			/requires a frontmatter description/
		);
	});

	test('resolves client targets and keeps managed-copy manifests in machine storage', async () => {
		await Promise.all([
			writeSkill(joinPath(globalRepository, 'skills'), 'review', 'Review', 'Review changes.'),
			writeSkill(
				joinPath(activeRepository, '.repository-context', 'skills'),
				'release',
				'Release',
				'Prepare releases.'
			),
		]);
		skillService = disposables.add(new ContextSkillService(
			fileService,
			catalogService,
			canonicalConfigurationService,
			projectionService,
			storageService,
			pathService,
			pluginService
		));
		await skillService.refresh();

		const requestedTargets = projectionService.requests.map(request => request.target.path);
		assert.ok(requestedTargets.includes('/home/.agents/skills/review'));
		assert.ok(requestedTargets.includes('/project/.agents/skills/release'));
		assert.ok(requestedTargets.includes('/home/.claude/skills/review'));
		assert.ok(requestedTargets.includes('/project/.claude/skills/release'));
		assert.strictEqual(
			projectionService.requests.find(request => request.client === 'cursor' && request.skillId === 'review')
				?.target.path,
			'/home/.agents/skills/review'
		);
		assert.strictEqual(
			projectionService.requests.find(request => request.client === 'cursor' && request.skillId === 'release')
				?.target.path,
			'/project/.agents/skills/release'
		);
		assert.strictEqual(
			skillService.snapshot.sections.enabled.find(skill => skill.id === 'review')
				?.projections.find(projection => projection.client === 'codex')?.state,
			'missing'
		);

		await skillService.project('review', 'codex');
		assert.strictEqual(
			skillService.snapshot.sections.enabled.find(skill => skill.id === 'review')
				?.projections.find(projection => projection.client === 'codex')?.state,
			'copied'
		);
		const stored = storageService.getObject(
			'repositoryContext.skillProjection.manifests',
			StorageScope.PROFILE
		) as {
			manifests: Record<string, { sourceHash: string; outputHash: string }>;
		} | undefined;
		const manifest = stored?.manifests['inmemory:/home/.agents/skills/review'];
		assert.strictEqual(manifest?.sourceHash, 'a'.repeat(64));
		assert.strictEqual(manifest?.outputHash, 'a'.repeat(64));

		const target = URI.from({ scheme: Schemas.inMemory, path: '/home/.agents/skills/review' });
		projectionService.results.set(target.toString(), {
			state: 'modified',
			mode: 'managed-copy',
			detail: 'External change.',
		});
		await skillService.refresh();
		assert.strictEqual(
			skillService.snapshot.sections.enabled.find(skill => skill.id === 'review')
				?.projections.find(projection => projection.client === 'codex')?.state,
			'modified'
		);

		await skillService.importChanges('review', 'codex');
		await skillService.restoreProjection('review', 'codex');
		assert.strictEqual(projectionService.importCount, 1);
		assert.strictEqual(projectionService.restoreCount, 1);
	});

	test('validates Agent Skills compatibility and scopes overlays to one client', async () => {
		const skillDirectory = joinPath(
			activeRepository,
			'.repository-context',
			'skills',
			'release'
		);
		await fileService.createFolder(joinPath(skillDirectory, '.repository-context', 'overlays'));
		await fileService.writeFile(
			joinPath(skillDirectory, 'SKILL.md'),
			VSBuffer.fromString([
				'---',
				'name: release',
				'description: Prepare releases.',
				'allowed-tools: Read',
				'---',
				'',
				'# Release',
				'',
			].join('\n'))
		);
		await fileService.writeFile(
			joinPath(skillDirectory, '.repository-context', 'overlays', 'cursor.yaml'),
			VSBuffer.fromString('paths: src/**\n')
		);
		skillService = disposables.add(new ContextSkillService(
			fileService,
			catalogService,
			canonicalConfigurationService,
			projectionService,
			storageService,
			pathService,
			pluginService
		));
		await skillService.refresh();

		const skill = skillService.snapshot.sections.enabled.find(candidate => candidate.id === 'release');
		assert.strictEqual(
			skill?.projections.find(projection => projection.client === 'claude-code')?.compatibility,
			'compatible'
		);
		assert.strictEqual(
			skill?.projections.find(projection => projection.client === 'cursor')?.compatibility,
			'partial'
		);
		assert.match(
			skill?.projections.find(projection => projection.client === 'cursor')?.compatibilityReason ?? '',
			/allowed-tools/
		);
		const cursorRequest = projectionService.requests.find(request => request.client === 'cursor');
		assert.strictEqual(
			cursorRequest?.overlay?.path,
			'/project/.repository-context/skills/release/.repository-context/overlays/cursor.yaml'
		);
		assert.strictEqual(cursorRequest?.target.path, '/project/.cursor/skills/release');
		assert.strictEqual(
			projectionService.requests.find(request => request.client === 'claude-code')?.overlay,
			undefined
		);
	});
});
