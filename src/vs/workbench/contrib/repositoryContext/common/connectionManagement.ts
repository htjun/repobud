/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export type ConnectionState = 'valid' | 'expired' | 'rejected' | 'missing' | 'identityMismatch';
export type EffectiveConnectionState = ConnectionState | 'ambiguous';
export type ConnectionSelectionSource = 'repository' | 'global' | 'automatic' | 'none';

export interface IConnectionRecord {
	readonly id: string;
	readonly integrationId: string;
	readonly provider: 'github';
	readonly accountId: string;
	readonly accountLabel: string;
	readonly tenant: 'github.com';
	readonly state: ConnectionState;
	readonly scopes: readonly string[];
	readonly createdAt: number;
	readonly lastValidatedAt: number;
	readonly expiresAt?: number;
}

export interface IEffectiveConnectionGroup {
	readonly integrationId: string;
	readonly connections: readonly IConnectionRecord[];
	readonly selectedConnectionId?: string;
	readonly selectionSource: ConnectionSelectionSource;
	readonly state: EffectiveConnectionState;
	readonly issue?: string;
}

export interface IConnectionManagementSnapshot {
	readonly groups: readonly IEffectiveConnectionGroup[];
	readonly loading: boolean;
	readonly error?: string;
}

export const IContextConnectionService =
	createDecorator<IContextConnectionService>('contextConnectionService');

export interface IContextConnectionService {
	readonly _serviceBrand: undefined;
	readonly snapshot: IConnectionManagementSnapshot;
	readonly onDidChange: Event<IConnectionManagementSnapshot>;

	refresh(): Promise<void>;
	addGitHubConnection(integrationId: string, token: string): Promise<IConnectionRecord>;
	validateConnection(id: string): Promise<void>;
	setRepositoryConnection(integrationId: string, connectionId: string | undefined): Promise<void>;
	setGlobalConnection(integrationId: string, connectionId: string): Promise<void>;
	disconnect(id: string): Promise<void>;
}
