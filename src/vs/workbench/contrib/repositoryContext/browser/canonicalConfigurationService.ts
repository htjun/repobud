/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Repository Context Workbench contributors.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import {
	createCanonicalConfiguration,
	GLOBAL_CONFIGURATION_FILE,
	ICanonicalConfiguration,
	ICanonicalConfigurationService,
	parseCanonicalConfiguration,
	REPOSITORY_CONFIGURATION_DIRECTORY,
	REPOSITORY_CONFIGURATION_FILE,
	serializeCanonicalConfiguration,
} from '../common/canonicalConfiguration.js';
import { getRepositoryAvailability, IRepositoryCatalogService } from '../common/repositoryCatalog.js';

export class CanonicalConfigurationService extends Disposable implements ICanonicalConfigurationService {

	private static readonly GLOBAL_REPOSITORY_STORAGE_KEY = 'repositoryContext.globalConfigurationRepository';
	private static readonly ATOMIC_WRITE_POSTFIX = '.repository-context-tmp';

	declare readonly _serviceBrand: undefined;

	private _globalRepository: URI | undefined;
	private readonly _onDidChangeGlobalRepository = this._register(new Emitter<URI | undefined>());
	readonly onDidChangeGlobalRepository = this._onDidChangeGlobalRepository.event;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IRepositoryCatalogService private readonly repositoryCatalogService: IRepositoryCatalogService,
	) {
		super();
		this._globalRepository = this.restoreGlobalRepository();
	}

	get globalRepository(): URI | undefined {
		return this._globalRepository;
	}

	async adoptGlobalRepository(uri: URI): Promise<void> {
		const availability = await getRepositoryAvailability(uri, resource => this.fileService.exists(resource));
		if (availability !== 'ready') {
			throw new Error(availability === 'missing'
				? `Configuration repository folder does not exist: ${uri.fsPath}`
				: `Configuration repository is not a Git repository: ${uri.fsPath}`);
		}

		const configurationResource = joinPath(uri, GLOBAL_CONFIGURATION_FILE);
		if (await this.fileService.exists(configurationResource)) {
			await this.readConfiguration(configurationResource, 'global');
		} else {
			await this.writeConfiguration(configurationResource, createCanonicalConfiguration('global'));
		}

		await this.repositoryCatalogService.add(uri);
		this._globalRepository = uri;
		this.storageService.store(
			CanonicalConfigurationService.GLOBAL_REPOSITORY_STORAGE_KEY,
			uri.toString(),
			StorageScope.APPLICATION,
			StorageTarget.MACHINE
		);
		this._onDidChangeGlobalRepository.fire(uri);
	}

	async readGlobalConfiguration(): Promise<ICanonicalConfiguration | undefined> {
		if (!this._globalRepository) {
			return undefined;
		}
		return this.readConfiguration(joinPath(this._globalRepository, GLOBAL_CONFIGURATION_FILE), 'global');
	}

	async writeGlobalConfiguration(configuration: ICanonicalConfiguration): Promise<void> {
		if (!this._globalRepository) {
			throw new Error('Select a global configuration repository before writing configuration.');
		}
		await this.writeConfiguration(
			joinPath(this._globalRepository, GLOBAL_CONFIGURATION_FILE),
			configuration,
			'global'
		);
	}

	async readRepositoryConfiguration(repository: URI): Promise<ICanonicalConfiguration> {
		const resource = this.getRepositoryConfigurationResource(repository);
		if (!await this.fileService.exists(resource)) {
			return createCanonicalConfiguration('repository');
		}
		return this.readConfiguration(resource, 'repository');
	}

	async writeRepositoryConfiguration(repository: URI, configuration: ICanonicalConfiguration): Promise<void> {
		const directory = joinPath(repository, REPOSITORY_CONFIGURATION_DIRECTORY);
		await this.fileService.createFolder(directory);
		await this.writeConfiguration(
			joinPath(directory, REPOSITORY_CONFIGURATION_FILE),
			configuration,
			'repository'
		);
	}

	private getRepositoryConfigurationResource(repository: URI): URI {
		return joinPath(repository, REPOSITORY_CONFIGURATION_DIRECTORY, REPOSITORY_CONFIGURATION_FILE);
	}

	private async readConfiguration(
		resource: URI,
		expectedScope: 'global' | 'repository',
	): Promise<ICanonicalConfiguration> {
		const content = await this.fileService.readFile(resource, { atomic: true });
		return parseCanonicalConfiguration(content.value.toString(), expectedScope);
	}

	private async writeConfiguration(
		resource: URI,
		configuration: ICanonicalConfiguration,
		expectedScope: 'global' | 'repository' = configuration.scope,
	): Promise<void> {
		if (configuration.scope !== expectedScope) {
			throw new Error(`Cannot write ${configuration.scope} configuration to the ${expectedScope} configuration location.`);
		}
		await this.fileService.writeFile(
			resource,
			VSBuffer.fromString(serializeCanonicalConfiguration(configuration)),
			{ atomic: { postfix: CanonicalConfigurationService.ATOMIC_WRITE_POSTFIX } }
		);
	}

	private restoreGlobalRepository(): URI | undefined {
		const stored = this.storageService.get(
			CanonicalConfigurationService.GLOBAL_REPOSITORY_STORAGE_KEY,
			StorageScope.APPLICATION
		);
		if (!stored) {
			return undefined;
		}
		try {
			return URI.parse(stored);
		} catch {
			return undefined;
		}
	}
}

registerSingleton(
	ICanonicalConfigurationService,
	CanonicalConfigurationService,
	InstantiationType.Delayed
);
