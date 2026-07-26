/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { getRepositoryAvailability, IRepositoryCatalogEntry, IRepositoryCatalogService, RepositoryCatalogModel } from '../common/repositoryCatalog.js';

export class RepositoryCatalogService extends Disposable implements IRepositoryCatalogService {

	private static readonly STORAGE_KEY = 'repoBud.catalog';

	declare readonly _serviceBrand: undefined;

	private readonly model: RepositoryCatalogModel;
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	readonly activeRepository: URI | undefined;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
	) {
		super();

		this.model = RepositoryCatalogModel.restore(
			this.storageService.get(RepositoryCatalogService.STORAGE_KEY, StorageScope.APPLICATION)
		);
		this.activeRepository = workspaceContextService.getWorkspace().folders.at(0)?.uri;

		void this.initialize();
	}

	get entries(): readonly IRepositoryCatalogEntry[] {
		return this.model.entries;
	}

	async add(uri: URI): Promise<IRepositoryCatalogEntry> {
		const entry = await this.createEntry(uri);
		this.model.add(entry);
		this.store();
		this._onDidChange.fire();
		return entry;
	}

	remove(uri: URI): void {
		if (!this.model.remove(uri)) {
			return;
		}

		this.store();
		this._onDidChange.fire();
	}

	async refresh(): Promise<void> {
		const entries = await Promise.all(this.model.entries.map(entry => this.createEntry(entry.uri)));
		for (const entry of entries) {
			this.model.add(entry);
		}
		this._onDidChange.fire();
	}

	private async initialize(): Promise<void> {
		if (this.activeRepository) {
			await this.add(this.activeRepository);
		}
		await this.refresh();
	}

	private async createEntry(uri: URI): Promise<IRepositoryCatalogEntry> {
		return {
			uri,
			availability: await getRepositoryAvailability(uri, resource => this.fileService.exists(resource)),
		};
	}

	private store(): void {
		this.storageService.store(
			RepositoryCatalogService.STORAGE_KEY,
			this.model.serialize(),
			StorageScope.APPLICATION,
			StorageTarget.MACHINE
		);
	}
}

registerSingleton(IRepositoryCatalogService, RepositoryCatalogService, InstantiationType.Delayed);
