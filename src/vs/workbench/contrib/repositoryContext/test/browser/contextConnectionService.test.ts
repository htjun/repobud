/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
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
import { FileSystemProviderCapabilities } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import {
	IGitHubCredentialService,
	IGitHubCredentialValidation,
} from '../../../../../platform/repositoryContext/common/githubCredentialService.js';
import { IKeychainCredentialService } from '../../../../../platform/repositoryContext/common/keychainCredentialService.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { CanonicalConfigurationService } from '../../browser/canonicalConfigurationService.js';
import { ContextConnectionService } from '../../browser/contextConnectionService.js';
import { createCanonicalConfiguration } from '../../common/canonicalConfiguration.js';
import {
	IMcpIntegrationService,
	IMcpIntegrationSnapshot,
} from '../../common/mcpIntegration.js';
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

class TestKeychainCredentialService implements IKeychainCredentialService {

	declare readonly _serviceBrand: undefined;
	readonly secrets = new Map<string, string>();

	constructor(private readonly available = true) { }

	async isAvailable(): Promise<boolean> { return this.available; }
	async get(connectionId: string): Promise<string | undefined> {
		return this.secrets.get(connectionId);
	}
	async set(connectionId: string, secret: string): Promise<void> {
		this.secrets.set(connectionId, secret);
	}
	async delete(connectionId: string): Promise<void> {
		this.secrets.delete(connectionId);
	}
}

class TestGitHubConnectionValidator implements IGitHubCredentialService {

	declare readonly _serviceBrand: undefined;
	readonly results = new Map<string, IGitHubCredentialValidation>();

	async validate(token: string): Promise<IGitHubCredentialValidation> {
		const result = this.results.get(token);
		if (!result) {
			throw new Error('Unexpected test token.');
		}
		return result;
	}
}

class TestMcpIntegrationService implements IMcpIntegrationService {

	declare readonly _serviceBrand: undefined;
	readonly onDidChange = Event.None;

	readonly snapshot: IMcpIntegrationSnapshot;

	constructor(activeRepository: URI, globalRepository: URI) {
		this.snapshot = {
			activeRepository,
			globalRepository,
			sections: {
				enabled: [{
					id: 'github-tools',
					name: 'GitHub tools',
					description: 'Uses a GitHub Connection.',
					origins: ['global'],
					activation: 'on',
					clients: [],
					repositoryOverride: undefined,
					section: 'enabled',
					definition: {
						version: 1,
						id: 'github-tools',
						name: 'GitHub tools',
						description: 'Uses a GitHub Connection.',
						transport: { type: 'http', url: 'https://example.com/mcp' },
						connection: { provider: 'github' },
					},
					health: { state: 'unknown', capabilities: [] },
					projections: [],
				}],
				available: [],
				needsAttention: [],
			},
			errors: [],
			loading: false,
		};
	}

	async refresh(): Promise<void> { }
	async setRepositoryOverride(): Promise<void> { }
	async checkHealth(): Promise<void> { }
	async project(): Promise<void> { }
}

suite('ContextConnectionService', () => {

	const disposables = new DisposableStore();
	let fileService: FileService;
	let activeRepository: URI;
	let globalRepository: URI;
	let storageService: InMemoryStorageService;
	let keychainCredentialService: TestKeychainCredentialService;
	let validator: TestGitHubConnectionValidator;
	let canonicalConfigurationService: CanonicalConfigurationService;
	let integrationService: TestMcpIntegrationService;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		const provider = disposables.add(new AtomicInMemoryFileSystemProvider());
		disposables.add(fileService.registerProvider(Schemas.inMemory, provider));
		activeRepository = URI.from({ scheme: Schemas.inMemory, path: '/project' });
		globalRepository = URI.from({ scheme: Schemas.inMemory, path: '/global' });
		await Promise.all([
			fileService.createFolder(joinPath(activeRepository, '.git')),
			fileService.createFolder(joinPath(globalRepository, '.git')),
		]);
		storageService = disposables.add(new InMemoryStorageService());
		keychainCredentialService = new TestKeychainCredentialService();
		validator = new TestGitHubConnectionValidator();
		canonicalConfigurationService = disposables.add(new CanonicalConfigurationService(
			storageService,
			fileService,
			new TestRepositoryCatalogService(activeRepository)
		));
		await canonicalConfigurationService.adoptGlobalRepository(globalRepository);
		await Promise.all([
			canonicalConfigurationService.writeGlobalConfiguration(
				createCanonicalConfiguration('global')
			),
			canonicalConfigurationService.writeRepositoryConfiguration(
				activeRepository,
				createCanonicalConfiguration('repository')
			),
		]);
		integrationService = new TestMcpIntegrationService(activeRepository, globalRepository);
	});

	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	function createService(
		credentialService: IKeychainCredentialService = keychainCredentialService,
	): ContextConnectionService {
		return disposables.add(new ContextConnectionService(
			storageService,
			credentialService,
			validator,
			canonicalConfigurationService,
			integrationService
		));
	}

	function setValidToken(token: string, accountId: string, accountLabel: string): void {
		validator.results.set(token, {
			state: 'valid',
			accountId,
			accountLabel,
			scopes: ['read:user', 'repo'],
		});
	}

	test('supports multiple accounts with independent global and repository selection', async () => {
		setValidToken('token-alpha', '101', 'alpha');
		setValidToken('token-beta', '202', 'beta');
		const service = createService();
		const alpha = await service.addGitHubConnection('github-tools', 'token-alpha');
		const beta = await service.addGitHubConnection('github-tools', 'token-beta');

		assert.strictEqual(service.snapshot.groups[0].state, 'ambiguous');
		assert.strictEqual(service.snapshot.groups[0].connections.length, 2);

		await service.setGlobalConnection('github-tools', alpha.id);
		assert.strictEqual(service.snapshot.groups[0].selectedConnectionId, alpha.id);
		assert.strictEqual(service.snapshot.groups[0].selectionSource, 'global');
		await service.setRepositoryConnection('github-tools', beta.id);
		assert.strictEqual(service.snapshot.groups[0].selectedConnectionId, beta.id);
		assert.strictEqual(service.snapshot.groups[0].selectionSource, 'repository');

		const repositoryConfiguration = await canonicalConfigurationService.readRepositoryConfiguration(
			activeRepository
		);
		const globalConfiguration = await canonicalConfigurationService.readGlobalConfiguration();
		assert.strictEqual(repositoryConfiguration.integrations['github-tools'].connection, beta.id);
		assert.strictEqual(globalConfiguration?.integrations['github-tools'].connection, alpha.id);
		const portableFiles = [
			await fileService.readFile(joinPath(activeRepository, '.repository-context', 'config.json')),
			await fileService.readFile(joinPath(globalRepository, 'repository-context.json')),
		].map(file => file.value.toString()).join('\n');
		assert.doesNotMatch(portableFiles, /token-alpha|token-beta|alpha|beta/);
		assert.strictEqual(keychainCredentialService.secrets.size, 2);
	});

	test('reports expired, rejected, and missing credentials as needing attention', async () => {
		setValidToken('token-alpha', '101', 'alpha');
		const service = createService();
		const connection = await service.addGitHubConnection('github-tools', 'token-alpha');
		await service.setRepositoryConnection('github-tools', connection.id);

		validator.results.set('token-alpha', { state: 'expired', scopes: [] });
		await service.validateConnection(connection.id);
		assert.strictEqual(service.snapshot.groups[0].state, 'expired');
		assert.match(service.snapshot.groups[0].issue ?? '', /expired/);

		validator.results.set('token-alpha', { state: 'rejected', scopes: [] });
		await service.validateConnection(connection.id);
		assert.strictEqual(service.snapshot.groups[0].state, 'rejected');

		await keychainCredentialService.delete(connection.id);
		await service.validateConnection(connection.id);
		assert.strictEqual(service.snapshot.groups[0].state, 'missing');
		assert.match(service.snapshot.groups[0].issue ?? '', /missing/);
	});

	test('disconnect removes only machine-local credential state', async () => {
		setValidToken('token-alpha', '101', 'alpha');
		const service = createService();
		const connection = await service.addGitHubConnection('github-tools', 'token-alpha');
		await service.setRepositoryConnection('github-tools', connection.id);

		await service.disconnect(connection.id);

		assert.strictEqual(keychainCredentialService.secrets.size, 0);
		assert.strictEqual(service.snapshot.groups[0].connections.length, 1);
		assert.strictEqual(service.snapshot.groups[0].state, 'missing');
		assert.strictEqual(
			(await canonicalConfigurationService.readRepositoryConfiguration(activeRepository))
				.integrations['github-tools'].connection,
			connection.id
		);
		assert.strictEqual(integrationService.snapshot.sections.enabled[0].id, 'github-tools');

		setValidToken('token-reconnected', '101', 'alpha-renamed');
		const reconnected = await service.addGitHubConnection('github-tools', 'token-reconnected');
		assert.strictEqual(reconnected.id, connection.id);
		assert.strictEqual(reconnected.accountLabel, 'alpha-renamed');
		assert.strictEqual(service.snapshot.groups[0].state, 'valid');
	});

	test('rejects identity changes without silently rebinding a Connection', async () => {
		setValidToken('token-alpha', '101', 'alpha');
		const service = createService();
		const connection = await service.addGitHubConnection('github-tools', 'token-alpha');
		await service.setRepositoryConnection('github-tools', connection.id);

		validator.results.set('token-alpha', {
			state: 'valid',
			accountId: '202',
			accountLabel: 'beta',
			scopes: [],
		});
		await service.validateConnection(connection.id);

		assert.strictEqual(service.snapshot.groups[0].state, 'identityMismatch');
		assert.strictEqual(service.snapshot.groups[0].connections[0].accountId, '101');
	});

	test('refuses to persist tokens when macOS Keychain is unavailable', async () => {
		setValidToken('token-alpha', '101', 'alpha');
		const unavailableKeychain = new TestKeychainCredentialService(false);
		const service = createService(unavailableKeychain);

		await assert.rejects(
			() => service.addGitHubConnection('github-tools', 'token-alpha'),
			/macOS Keychain is unavailable/
		);
		assert.strictEqual(unavailableKeychain.secrets.size, 0);
	});
});
