/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Repository Context Workbench contributors.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { FileSystemProviderCapabilities, IFileWriteOptions } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { CanonicalConfigurationService } from '../../browser/canonicalConfigurationService.js';
import {
	createCanonicalConfiguration,
	GLOBAL_CONFIGURATION_FILE,
	REPOSITORY_CONFIGURATION_DIRECTORY,
	REPOSITORY_CONFIGURATION_FILE,
} from '../../common/canonicalConfiguration.js';
import { IRepositoryCatalogEntry, IRepositoryCatalogService } from '../../common/repositoryCatalog.js';

class RecordingFileSystemProvider extends InMemoryFileSystemProvider {

	lastWriteOptions: IFileWriteOptions | undefined;

	override get capabilities(): FileSystemProviderCapabilities {
		return super.capabilities | FileSystemProviderCapabilities.FileAtomicWrite;
	}

	override async writeFile(resource: URI, content: Uint8Array, options: IFileWriteOptions): Promise<void> {
		this.lastWriteOptions = options;
		await super.writeFile(resource, content, options);
	}
}

class TestRepositoryCatalogService implements IRepositoryCatalogService {

	declare readonly _serviceBrand: undefined;
	readonly activeRepository = undefined;
	readonly onDidChange = Event.None;
	private readonly storedEntries: IRepositoryCatalogEntry[] = [];

	get entries(): readonly IRepositoryCatalogEntry[] {
		return this.storedEntries;
	}

	async add(uri: URI): Promise<IRepositoryCatalogEntry> {
		const entry: IRepositoryCatalogEntry = { uri, availability: 'ready' };
		this.storedEntries.push(entry);
		return entry;
	}

	remove(uri: URI): void {
		const index = this.storedEntries.findIndex(entry => entry.uri.toString() === uri.toString());
		if (index !== -1) {
			this.storedEntries.splice(index, 1);
		}
	}

	async refresh(): Promise<void> { }
}

suite('CanonicalConfigurationService', () => {

	const disposables = new DisposableStore();
	let fileService: FileService;
	let fileSystemProvider: RecordingFileSystemProvider;
	let storageService: InMemoryStorageService;
	let catalogService: TestRepositoryCatalogService;
	let service: CanonicalConfigurationService;

	setup(() => {
		fileService = disposables.add(new FileService(new NullLogService()));
		fileSystemProvider = disposables.add(new RecordingFileSystemProvider());
		disposables.add(fileService.registerProvider(Schemas.inMemory, fileSystemProvider));
		storageService = disposables.add(new InMemoryStorageService());
		catalogService = new TestRepositoryCatalogService();
		service = disposables.add(new CanonicalConfigurationService(storageService, fileService, catalogService));
	});

	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	test('adopts a Git repository and atomically creates global configuration', async () => {
		const repository = URI.from({ scheme: Schemas.inMemory, path: '/configuration' });
		await fileService.createFolder(joinPath(repository, '.git'));

		await service.adoptGlobalRepository(repository);

		assert.strictEqual(service.globalRepository?.toString(), repository.toString());
		assert.strictEqual(catalogService.entries[0].uri.toString(), repository.toString());
		assert.deepStrictEqual(fileSystemProvider.lastWriteOptions?.atomic, { postfix: '.repository-context-tmp' });
		const content = await fileService.readFile(joinPath(repository, GLOBAL_CONFIGURATION_FILE));
		assert.strictEqual(content.value.toString(), [
			'{',
			'\t"version": 1,',
			'\t"scope": "global",',
			'\t"skills": {},',
			'\t"integrations": {}',
			'}',
			'',
		].join('\n'));

		const restoredService = disposables.add(new CanonicalConfigurationService(
			storageService,
			fileService,
			catalogService
		));
		assert.strictEqual(restoredService.globalRepository?.toString(), repository.toString());
	});

	test('writes portable repository-local configuration atomically', async () => {
		const repository = URI.from({ scheme: Schemas.inMemory, path: '/project' });
		await fileService.createFolder(repository);

		await service.writeRepositoryConfiguration(repository, {
			...createCanonicalConfiguration('repository'),
			skills: {
				'project-skill': { activation: 'on' },
			},
		});

		assert.deepStrictEqual(fileSystemProvider.lastWriteOptions?.atomic, { postfix: '.repository-context-tmp' });
		const content = await fileService.readFile(joinPath(
			repository,
			REPOSITORY_CONFIGURATION_DIRECTORY,
			REPOSITORY_CONFIGURATION_FILE
		));
		assert.match(content.value.toString(), /"project-skill"/);
		assert.doesNotMatch(content.value.toString(), /machinePath|secret|cache|health/);
	});

	test('rejects a folder without a Git repository', async () => {
		const repository = URI.from({ scheme: Schemas.inMemory, path: '/not-a-repository' });
		await fileService.createFolder(repository);

		await assert.rejects(
			() => service.adoptGlobalRepository(repository),
			/not a Git repository/
		);
		assert.strictEqual(catalogService.entries.length, 0);
	});
});
