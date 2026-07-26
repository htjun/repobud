/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import {
	IInstalledPluginPackage,
	IPluginPackagePreview,
	IPluginSourceRequest,
	IPluginUpdateResult,
	IRepositoryContextPluginPackageService,
	PLUGINS_DIRECTORY,
	PluginUpdateStrategy,
} from '../../../../platform/repositoryContext/common/pluginPackage.js';
import { ICanonicalConfigurationService } from '../common/canonicalConfiguration.js';
import {
	IContextPluginService,
	IPluginManagementSnapshot,
} from '../common/pluginManagement.js';

export class ContextPluginService extends Disposable implements IContextPluginService {

	declare readonly _serviceBrand: undefined;

	private refreshRequest = 0;
	private _snapshot: IPluginManagementSnapshot;
	private readonly _onDidChange = this._register(new Emitter<IPluginManagementSnapshot>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		@ICanonicalConfigurationService private readonly canonicalConfigurationService: ICanonicalConfigurationService,
		@IRepositoryContextPluginPackageService private readonly packageService: IRepositoryContextPluginPackageService,
		@IFileService fileService: IFileService,
	) {
		super();
		this._snapshot = {
			globalRepository: canonicalConfigurationService.globalRepository,
			installed: [],
			updates: [],
			errors: [],
			loading: true,
		};
		this._register(canonicalConfigurationService.onDidChangeGlobalRepository(() => void this.refresh()));
		this._register(fileService.onDidFilesChange(event => {
			const globalRepository = this.canonicalConfigurationService.globalRepository;
			if (globalRepository && event.affects(joinPath(globalRepository, PLUGINS_DIRECTORY))) {
				void this.refresh();
			}
		}));
		void this.refresh();
	}

	get snapshot(): IPluginManagementSnapshot {
		return this._snapshot;
	}

	async refresh(checkUpdates = false): Promise<void> {
		const request = ++this.refreshRequest;
		const globalRepository = this.canonicalConfigurationService.globalRepository;
		this.updateSnapshot({ ...this._snapshot, globalRepository, loading: true, errors: [] });
		if (!globalRepository) {
			this.updateSnapshot({
				globalRepository,
				installed: [],
				updates: [],
				errors: [],
				loading: false,
			});
			return;
		}
		try {
			const [installed, updates] = await Promise.all([
				this.packageService.list(globalRepository),
				checkUpdates ? this.packageService.checkUpdates(globalRepository) : Promise.resolve([]),
			]);
			if (request !== this.refreshRequest) {
				return;
			}
			this.updateSnapshot({
				globalRepository,
				installed,
				updates,
				errors: [],
				loading: false,
			});
		} catch (error) {
			if (request !== this.refreshRequest) {
				return;
			}
			this.updateSnapshot({
				globalRepository,
				installed: [],
				updates: [],
				errors: [error instanceof Error ? error.message : String(error)],
				loading: false,
			});
		}
	}

	preview(source: IPluginSourceRequest): Promise<IPluginPackagePreview> {
		return this.packageService.preview(source);
	}

	async install(
		source: IPluginSourceRequest,
		expectedContentHash: string,
		trustExecutableContent: boolean,
	): Promise<IInstalledPluginPackage> {
		const repository = this.getGlobalRepository();
		const installed = await this.packageService.install(
			repository,
			source,
			expectedContentHash,
			trustExecutableContent
		);
		await this.refresh();
		return installed;
	}

	async setEnabled(pluginId: string, enabled: boolean): Promise<IInstalledPluginPackage> {
		const installed = await this.packageService.setEnabled(
			this.getGlobalRepository(),
			pluginId,
			enabled
		);
		await this.refresh();
		return installed;
	}

	async grantTrust(pluginId: string): Promise<IInstalledPluginPackage> {
		const installed = await this.packageService.grantTrust(
			this.getGlobalRepository(),
			pluginId
		);
		await this.refresh();
		return installed;
	}

	async uninstall(pluginId: string): Promise<void> {
		await this.packageService.uninstall(this.getGlobalRepository(), pluginId);
		await this.refresh();
	}

	async applyUpdate(
		pluginId: string,
		strategy: PluginUpdateStrategy,
		expectedContentHash: string,
		trustExecutableContent: boolean,
	): Promise<IPluginUpdateResult> {
		const result = await this.packageService.applyUpdate(
			this.getGlobalRepository(),
			pluginId,
			strategy,
			expectedContentHash,
			trustExecutableContent
		);
		await this.refresh(true);
		return result;
	}

	private getGlobalRepository() {
		const repository = this.canonicalConfigurationService.globalRepository;
		if (!repository) {
			throw new Error('Select a global configuration repository before managing Plugins.');
		}
		return repository;
	}

	private updateSnapshot(snapshot: IPluginManagementSnapshot): void {
		this._snapshot = snapshot;
		this._onDidChange.fire(snapshot);
	}
}

registerSingleton(IContextPluginService, ContextPluginService, InstantiationType.Delayed);
