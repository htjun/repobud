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
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { CanonicalConfigurationService } from '../../browser/canonicalConfigurationService.js';
import { ContextSkillService } from '../../browser/contextSkillService.js';
import { createCanonicalConfiguration } from '../../common/canonicalConfiguration.js';
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

suite('ContextSkillService', () => {

	const disposables = new DisposableStore();
	let fileService: FileService;
	let storageService: InMemoryStorageService;
	let activeRepository: URI;
	let globalRepository: URI;
	let catalogService: TestRepositoryCatalogService;
	let canonicalConfigurationService: CanonicalConfigurationService;
	let skillService: ContextSkillService;

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
			`name: ${name}`,
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
			canonicalConfigurationService
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
			canonicalConfigurationService
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
});
