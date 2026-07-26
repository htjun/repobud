/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	IInstalledPluginPackage,
	IPluginPackagePreview,
	IPluginPackageUpdate,
	IPluginSourceRequest,
	IPluginUpdateResult,
	PluginUpdateStrategy,
} from '../../../../platform/repoBud/common/pluginPackage.js';

export interface IPluginManagementSnapshot {
	readonly globalRepository: URI | undefined;
	readonly installed: readonly IInstalledPluginPackage[];
	readonly updates: readonly IPluginPackageUpdate[];
	readonly errors: readonly string[];
	readonly loading: boolean;
}

export const IContextPluginService =
	createDecorator<IContextPluginService>('contextPluginService');

export interface IContextPluginService {
	readonly _serviceBrand: undefined;
	readonly snapshot: IPluginManagementSnapshot;
	readonly onDidChange: Event<IPluginManagementSnapshot>;

	refresh(checkUpdates?: boolean): Promise<void>;
	preview(source: IPluginSourceRequest): Promise<IPluginPackagePreview>;
	install(
		source: IPluginSourceRequest,
		expectedContentHash: string,
		trustExecutableContent: boolean,
	): Promise<IInstalledPluginPackage>;
	setEnabled(pluginId: string, enabled: boolean): Promise<IInstalledPluginPackage>;
	grantTrust(pluginId: string): Promise<IInstalledPluginPackage>;
	uninstall(pluginId: string): Promise<void>;
	applyUpdate(
		pluginId: string,
		strategy: PluginUpdateStrategy,
		expectedContentHash: string,
		trustExecutableContent: boolean,
	): Promise<IPluginUpdateResult>;
}
