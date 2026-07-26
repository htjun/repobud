/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import {
	IGitHubCredentialService,
	IGitHubCredentialValidation,
} from '../../../../platform/repositoryContext/common/githubCredentialService.js';
import { IKeychainCredentialService } from '../../../../platform/repositoryContext/common/keychainCredentialService.js';
import {
	IStorageService,
	StorageScope,
	StorageTarget,
} from '../../../../platform/storage/common/storage.js';
import {
	ConnectionState,
	IConnectionManagementSnapshot,
	IConnectionRecord,
	IContextConnectionService,
	IEffectiveConnectionGroup,
} from '../common/connectionManagement.js';
import {
	ICanonicalConfiguration,
	ICanonicalConfigurationService,
	ICanonicalIntegrationSetting,
} from '../common/canonicalConfiguration.js';
import { IMcpIntegrationService } from '../common/mcpIntegration.js';

interface IStoredConnectionRegistry {
	readonly version: 1;
	readonly connections: readonly IConnectionRecord[];
}

const CONNECTION_REGISTRY_KEY = 'repositoryContext.connections.registry';

export class ContextConnectionService extends Disposable implements IContextConnectionService {

	declare readonly _serviceBrand: undefined;

	private _snapshot: IConnectionManagementSnapshot = { groups: [], loading: true };
	private readonly _onDidChange = this._register(new Emitter<IConnectionManagementSnapshot>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IKeychainCredentialService private readonly keychainCredentialService: IKeychainCredentialService,
		@IGitHubCredentialService private readonly validator: IGitHubCredentialService,
		@ICanonicalConfigurationService private readonly canonicalConfigurationService: ICanonicalConfigurationService,
		@IMcpIntegrationService private readonly integrationService: IMcpIntegrationService,
	) {
		super();
		this._register(integrationService.onDidChange(() => void this.refresh()));
		void this.refresh();
	}

	get snapshot(): IConnectionManagementSnapshot {
		return this._snapshot;
	}

	async refresh(): Promise<void> {
		this.updateSnapshot({ ...this._snapshot, loading: true, error: undefined });
		try {
			const repository = this.integrationService.snapshot.activeRepository;
			const [globalConfiguration, repositoryConfiguration] = await Promise.all([
				this.canonicalConfigurationService.readGlobalConfiguration(),
				repository
					? this.canonicalConfigurationService.readRepositoryConfiguration(repository)
					: undefined,
			]);
			const records = this.readRegistry();
			const integrations = [
				...this.integrationService.snapshot.sections.enabled,
				...this.integrationService.snapshot.sections.available,
				...this.integrationService.snapshot.sections.needsAttention,
			].filter(integration => integration.definition?.connection?.provider === 'github');
			this.updateSnapshot({
				groups: integrations.map(integration => this.resolveGroup(
					integration.id,
					records,
					globalConfiguration?.integrations[integration.id],
					repositoryConfiguration?.integrations[integration.id],
				)),
				loading: false,
			});
		} catch (error) {
			this.updateSnapshot({
				groups: [],
				loading: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async addGitHubConnection(integrationId: string, token: string): Promise<IConnectionRecord> {
		if (!token.trim()) {
			throw new Error('Enter a GitHub token.');
		}
		if (!await this.keychainCredentialService.isAvailable()) {
			throw new Error('macOS Keychain is unavailable. The GitHub token was not stored.');
		}
		const validation = await this.validator.validate(token);
		if (validation.state !== 'valid' || !validation.accountId || !validation.accountLabel) {
			throw new Error(validation.state === 'expired'
				? 'The GitHub token has expired.'
				: 'GitHub rejected the credential.');
		}
		const records = this.readRegistry();
		const existing = records.find(record =>
			record.integrationId === integrationId &&
			record.provider === 'github' &&
			record.accountId === validation.accountId
		);
		if (existing?.state === 'valid') {
			throw new Error(`GitHub account "${validation.accountLabel}" is already connected.`);
		}
		if (existing) {
			const reconnected = this.updateRecordFromValidation(existing, validation);
			await this.keychainCredentialService.set(existing.id, token);
			this.writeRegistry(records.map(record => record.id === existing.id ? reconnected : record));
			await this.refresh();
			return reconnected;
		}
		const record = this.createRecord(
			integrationId,
			validation,
			validation.accountId,
			validation.accountLabel
		);
		await this.keychainCredentialService.set(record.id, token);
		this.writeRegistry([...records, record]);
		await this.refresh();
		return record;
	}

	async validateConnection(id: string): Promise<void> {
		const records = this.readRegistry();
		const record = this.getRecord(records, id);
		const token = await this.keychainCredentialService.get(id);
		const next = token
			? this.updateRecordFromValidation(record, await this.validator.validate(token))
			: { ...record, state: 'missing' as const, lastValidatedAt: Date.now() };
		this.writeRegistry(records.map(candidate => candidate.id === id ? next : candidate));
		await this.refresh();
	}

	async setRepositoryConnection(
		integrationId: string,
		connectionId: string | undefined,
	): Promise<void> {
		const repository = this.integrationService.snapshot.activeRepository;
		if (!repository) {
			throw new Error('Select an active repository before choosing a Connection.');
		}
		const configuration = await this.canonicalConfigurationService.readRepositoryConfiguration(repository);
		await this.canonicalConfigurationService.writeRepositoryConfiguration(
			repository,
			this.withConnection(configuration, integrationId, connectionId)
		);
		await this.refresh();
	}

	async setGlobalConnection(integrationId: string, connectionId: string): Promise<void> {
		const configuration = await this.canonicalConfigurationService.readGlobalConfiguration();
		if (!configuration) {
			throw new Error('Select a configuration repository before choosing a global Connection.');
		}
		await this.canonicalConfigurationService.writeGlobalConfiguration(
			this.withConnection(configuration, integrationId, connectionId)
		);
		await this.refresh();
	}

	async disconnect(id: string): Promise<void> {
		const records = this.readRegistry();
		const record = this.getRecord(records, id);
		await this.keychainCredentialService.delete(id);
		this.writeRegistry(records.map(candidate => candidate.id === id
			? { ...record, state: 'missing', lastValidatedAt: Date.now() }
			: candidate
		));
		await this.refresh();
	}

	private resolveGroup(
		integrationId: string,
		records: readonly IConnectionRecord[],
		globalSetting: ICanonicalIntegrationSetting | undefined,
		repositorySetting: ICanonicalIntegrationSetting | undefined,
	): IEffectiveConnectionGroup {
		const connections = records
			.filter(record => record.integrationId === integrationId)
			.sort((left, right) => left.accountLabel.localeCompare(right.accountLabel));
		const configuredId = repositorySetting?.connection ?? globalSetting?.connection;
		const selectedConnectionId = configuredId ?? (connections.length === 1 ? connections[0].id : undefined);
		const selectionSource = repositorySetting?.connection
			? 'repository'
			: globalSetting?.connection
				? 'global'
				: connections.length === 1 ? 'automatic' : 'none';
		const selected = connections.find(connection => connection.id === selectedConnectionId);
		let state: IEffectiveConnectionGroup['state'];
		let issue: string | undefined;
		if (configuredId && !selected) {
			state = 'missing';
			issue = 'The selected Connection is not available on this Mac.';
		} else if (connections.length === 0) {
			state = 'missing';
			issue = 'Connect a GitHub account.';
		} else if (!selected) {
			state = 'ambiguous';
			issue = 'Choose which GitHub account this repository should use.';
		} else {
			state = selected.state;
			issue = this.getStateIssue(selected.state);
		}
		return {
			integrationId,
			connections,
			selectedConnectionId,
			selectionSource,
			state,
			issue,
		};
	}

	private withConnection(
		configuration: ICanonicalConfiguration,
		integrationId: string,
		connectionId: string | undefined,
	): ICanonicalConfiguration {
		const integrations = { ...configuration.integrations };
		const current = integrations[integrationId];
		const next = {
			...current,
			...(connectionId ? { connection: connectionId } : {}),
		};
		if (!connectionId) {
			delete (next as { connection?: string }).connection;
		}
		if (
			next.activation === undefined &&
			next.clients === undefined &&
			next.connection === undefined
		) {
			delete integrations[integrationId];
		} else {
			integrations[integrationId] = next;
		}
		return { ...configuration, integrations };
	}

	private createRecord(
		integrationId: string,
		validation: IGitHubCredentialValidation,
		accountId: string,
		accountLabel: string,
	): IConnectionRecord {
		const now = Date.now();
		return {
			id: `conn_${generateUuid().replaceAll('-', '')}`,
			integrationId,
			provider: 'github',
			accountId,
			accountLabel,
			tenant: 'github.com',
			state: 'valid',
			scopes: validation.scopes,
			createdAt: now,
			lastValidatedAt: now,
			expiresAt: validation.expiresAt,
		};
	}

	private updateRecordFromValidation(
		record: IConnectionRecord,
		validation: IGitHubCredentialValidation,
	): IConnectionRecord {
		if (
			validation.state === 'valid' &&
			validation.accountId !== undefined &&
			validation.accountId !== record.accountId
		) {
			return {
				...record,
				state: 'identityMismatch',
				lastValidatedAt: Date.now(),
			};
		}
		return {
			...record,
			state: validation.state,
			accountLabel: validation.accountLabel ?? record.accountLabel,
			scopes: validation.scopes,
			lastValidatedAt: Date.now(),
			expiresAt: validation.expiresAt,
		};
	}

	private getStateIssue(state: ConnectionState): string | undefined {
		switch (state) {
			case 'expired': return 'The selected GitHub credential has expired.';
			case 'rejected': return 'GitHub rejected the selected credential.';
			case 'missing': return 'The selected GitHub credential is missing from macOS Keychain.';
			case 'identityMismatch': return 'The credential belongs to a different GitHub account.';
			default: return undefined;
		}
	}

	private readRegistry(): IConnectionRecord[] {
		const stored = this.storageService.getObject<IStoredConnectionRegistry>(
			CONNECTION_REGISTRY_KEY,
			StorageScope.APPLICATION
		);
		return stored?.version === 1 && Array.isArray(stored.connections)
			? [...stored.connections]
			: [];
	}

	private writeRegistry(connections: readonly IConnectionRecord[]): void {
		this.storageService.store(
			CONNECTION_REGISTRY_KEY,
			{ version: 1, connections },
			StorageScope.APPLICATION,
			StorageTarget.MACHINE
		);
	}

	private getRecord(records: readonly IConnectionRecord[], id: string): IConnectionRecord {
		const record = records.find(candidate => candidate.id === id);
		if (!record) {
			throw new Error(`Connection "${id}" is not installed.`);
		}
		return record;
	}

	private updateSnapshot(snapshot: IConnectionManagementSnapshot): void {
		this._snapshot = snapshot;
		this._onDidChange.fire(snapshot);
	}
}

registerSingleton(
	IContextConnectionService,
	ContextConnectionService,
	InstantiationType.Delayed
);
