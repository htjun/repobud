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
	IMcpHealthRequest,
	IMcpHealthResult,
	IRepoBudMcpHealthService,
} from '../../../../../platform/repoBud/common/mcpHealth.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { CanonicalConfigurationService } from '../../browser/canonicalConfigurationService.js';
import { ContextMcpIntegrationService } from '../../browser/contextMcpIntegrationService.js';
import { createCanonicalConfiguration } from '../../common/canonicalConfiguration.js';
import { ICanonicalMcpDefinition, serializeCanonicalMcpDefinition } from '../../common/mcpIntegration.js';
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

class TestMcpHealthService implements IRepoBudMcpHealthService {

	declare readonly _serviceBrand: undefined;
	readonly requests: IMcpHealthRequest[] = [];

	async check(request: IMcpHealthRequest): Promise<IMcpHealthResult> {
		this.requests.push(request);
		return {
			state: 'healthy',
			checkedAt: 42,
			protocolVersion: '2025-06-18',
			capabilities: ['resources', 'tools'],
		};
	}
}

suite('ContextMcpIntegrationService', () => {

	const disposables = new DisposableStore();
	let fileService: FileService;
	let activeRepository: URI;
	let globalRepository: URI;
	let canonicalConfigurationService: CanonicalConfigurationService;
	let healthService: TestMcpHealthService;
	let integrationService: ContextMcpIntegrationService;
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
		activeRepository = URI.from({ scheme: Schemas.inMemory, path: '/project' });
		globalRepository = URI.from({ scheme: Schemas.inMemory, path: '/global' });
		await Promise.all([
			fileService.createFolder(joinPath(activeRepository, '.git')),
			fileService.createFolder(joinPath(globalRepository, '.git')),
		]);
		const catalogService = new TestRepositoryCatalogService(activeRepository);
		canonicalConfigurationService = disposables.add(new CanonicalConfigurationService(
			disposables.add(new InMemoryStorageService()),
			fileService,
			catalogService
		));
		await canonicalConfigurationService.adoptGlobalRepository(globalRepository);
		healthService = new TestMcpHealthService();
		integrationService = disposables.add(new ContextMcpIntegrationService(
			fileService,
			catalogService,
			canonicalConfigurationService,
			healthService,
			pluginService
		));
	});

	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	async function writeDefinition(
		root: URI,
		definition: ICanonicalMcpDefinition,
		repository = false,
	): Promise<void> {
		const directory = repository
			? joinPath(root, '.repobud', 'integrations')
			: joinPath(root, 'integrations');
		await fileService.createFolder(directory);
		await fileService.writeFile(
			joinPath(directory, `${definition.id}.json`),
			VSBuffer.fromString(serializeCanonicalMcpDefinition(definition))
		);
	}

	const localDefinition: ICanonicalMcpDefinition = {
		version: 1,
		id: 'local-files',
		name: 'Local Files',
		description: 'Reads repository files.',
		transport: { type: 'stdio', command: 'node', args: ['server.js'] },
	};

	const remoteDefinition: ICanonicalMcpDefinition = {
		version: 1,
		id: 'remote-issues',
		name: 'Remote Issues',
		description: 'Reads remote issues.',
		transport: { type: 'http', url: 'https://example.com/mcp' },
	};

	test('resolves local and remote definitions with independent repository overrides', async () => {
		await Promise.all([
			writeDefinition(globalRepository, localDefinition),
			writeDefinition(activeRepository, remoteDefinition, true),
		]);
		await canonicalConfigurationService.writeGlobalConfiguration({
			...createCanonicalConfiguration('global'),
			integrations: {
				'local-files': { activation: 'off', clients: ['codex', 'claude-code'] },
				'remote-issues': { clients: ['codex'] },
			},
		});
		await canonicalConfigurationService.writeRepositoryConfiguration(activeRepository, {
			...createCanonicalConfiguration('repository'),
			integrations: {
				'local-files': { activation: 'on', clients: ['claude-code'] },
				'remote-issues': { activation: 'off' },
			},
		});

		await integrationService.refresh();

		const local = integrationService.snapshot.sections.enabled[0];
		assert.strictEqual(local.id, 'local-files');
		assert.strictEqual(local.definition?.transport.type, 'stdio');
		assert.deepStrictEqual(local.clients, ['claude-code']);
		assert.strictEqual(
			local.projections.find(projection => projection.client === 'claude-code')?.state,
			'missing'
		);
		const remote = integrationService.snapshot.sections.available[0];
		assert.strictEqual(remote.id, 'remote-issues');
		assert.strictEqual(remote.definition?.transport.type, 'http');
		assert.deepStrictEqual(remote.clients, ['codex']);

		await integrationService.setRepositoryOverride('local-files', { clients: ['cursor'] });
		const inherited = integrationService.snapshot.sections.available.find(
			integration => integration.id === 'local-files'
		);
		assert.strictEqual(inherited?.activation, 'off');
		assert.deepStrictEqual(inherited?.clients, ['cursor']);
	});

	test('keeps disabled definitions available and health state outside canonical configuration', async () => {
		await writeDefinition(globalRepository, localDefinition);
		await canonicalConfigurationService.writeGlobalConfiguration({
			...createCanonicalConfiguration('global'),
			integrations: { 'local-files': { activation: 'off' } },
		});
		await integrationService.refresh();

		const disabled = integrationService.snapshot.sections.available[0];
		assert.strictEqual(disabled.id, 'local-files');
		assert.ok(disabled.definitionResource);
		assert.strictEqual(disabled.health.state, 'unknown');

		await integrationService.checkHealth('local-files');
		const checked = integrationService.snapshot.sections.available[0];
		assert.strictEqual(checked.health.state, 'healthy');
		assert.deepStrictEqual(checked.health.capabilities, ['resources', 'tools']);
		assert.strictEqual(healthService.requests[0].transport.type, 'stdio');

		const canonical = await canonicalConfigurationService.readGlobalConfiguration();
		assert.deepStrictEqual(canonical?.integrations['local-files'], { activation: 'off' });
		const serialized = (await fileService.readFile(
			joinPath(globalRepository, 'repobud.json')
		)).value.toString();
		assert.doesNotMatch(serialized, /healthy|resources|checkedAt/);
	});

	test('projects only a selected Claude Code entry and preserves unrelated fields', async () => {
		await writeDefinition(globalRepository, remoteDefinition);
		await canonicalConfigurationService.writeGlobalConfiguration({
			...createCanonicalConfiguration('global'),
			integrations: { 'remote-issues': { clients: ['claude-code'] } },
		});
		await fileService.writeFile(
			joinPath(activeRepository, '.mcp.json'),
			VSBuffer.fromString(JSON.stringify({
				projectSetting: true,
				mcpServers: { unmanaged: { type: 'stdio', command: 'other' } },
			}))
		);
		await integrationService.refresh();

		await integrationService.project('remote-issues', 'claude-code');

		const output = JSON.parse((await fileService.readFile(
			joinPath(activeRepository, '.mcp.json')
		)).value.toString());
		assert.strictEqual(output.projectSetting, true);
		assert.deepStrictEqual(output.mcpServers.unmanaged, { type: 'stdio', command: 'other' });
		assert.deepStrictEqual(output.mcpServers['remote-issues'], {
			type: 'http',
			url: 'https://example.com/mcp',
		});
		assert.strictEqual(
			integrationService.snapshot.sections.enabled[0].projections
				.find(projection => projection.client === 'claude-code')?.state,
			'projected'
		);
		await assert.rejects(
			() => integrationService.project('remote-issues', 'cursor'),
			/not supported/
		);
	});

	test('reports invalid definitions without exposing credential fields', async () => {
		const directory = joinPath(activeRepository, '.repobud', 'integrations');
		await fileService.createFolder(directory);
		await fileService.writeFile(
			joinPath(directory, 'unsafe.json'),
			VSBuffer.fromString(JSON.stringify({
				version: 1,
				id: 'unsafe',
				name: 'Unsafe',
				description: 'Contains a secret.',
				transport: {
					type: 'http',
					url: 'https://example.com/mcp',
					headers: { Authorization: 'secret-value' },
				},
			}))
		);
		await integrationService.refresh();

		const unsafe = integrationService.snapshot.sections.needsAttention[0];
		assert.strictEqual(unsafe.id, 'unsafe');
		assert.match(unsafe.issue ?? '', /unsupported fields: headers/);
		assert.doesNotMatch(unsafe.issue ?? '', /secret-value/);
	});
});
