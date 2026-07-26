/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { SkillProjectionClient } from '../../../../platform/repoBud/common/skillProjection.js';
import { ICanonicalIntegrationSetting } from '../common/canonicalConfiguration.js';
import {
	ConnectionState,
	IContextConnectionService,
	IEffectiveConnectionGroup,
} from '../common/connectionManagement.js';
import {
	IEffectiveMcpIntegration,
	IMcpIntegrationService,
	IMcpIntegrationSnapshot,
	McpIntegrationOrigin,
	McpIntegrationSection,
	McpHealthState,
} from '../common/mcpIntegration.js';
import { MANAGE_CONFIGURATION_REPOSITORY_COMMAND_ID } from './canonicalConfigurationActions.js';
import './media/integrationsView.css';

const sectionLabels: Readonly<Record<McpIntegrationSection, string>> = {
	enabled: localize('repoBudIntegrationsEnabled', 'Enabled'),
	available: localize('repoBudIntegrationsAvailable', 'Available'),
	needsAttention: localize('repoBudIntegrationsNeedsAttention', 'Needs attention'),
};

const originLabels: Readonly<Record<McpIntegrationOrigin, string>> = {
	global: localize('repoBudIntegrationOriginGlobal', 'Global'),
	repository: localize('repoBudIntegrationOriginRepository', 'Repository'),
	plugin: localize('repoBudIntegrationOriginPlugin', 'Plugin'),
};

const healthLabels: Readonly<Record<McpHealthState, string>> = {
	unknown: localize('repoBudIntegrationHealthUnknown', 'Not checked'),
	checking: localize('repoBudIntegrationHealthChecking', 'Checking'),
	healthy: localize('repoBudIntegrationHealthHealthy', 'Healthy'),
	unreachable: localize('repoBudIntegrationHealthUnreachable', 'Unreachable'),
};

const clientLabels: Readonly<Record<SkillProjectionClient, string>> = {
	codex: 'Codex',
	'claude-code': 'Claude Code',
	cursor: 'Cursor',
};

const connectionStateLabels: Readonly<Record<ConnectionState, string>> = {
	valid: localize('repoBudConnectionStateValid', 'Valid'),
	expired: localize('repoBudConnectionStateExpired', 'Expired'),
	rejected: localize('repoBudConnectionStateRejected', 'Rejected'),
	missing: localize('repoBudConnectionStateMissing', 'Missing'),
	identityMismatch: localize('repoBudConnectionStateIdentityMismatch', 'Identity mismatch'),
};

export class IntegrationsViewPane extends ViewPane {

	private readonly renderedDisposables = this._register(new DisposableStore());
	private content: HTMLElement | undefined;
	private integrationSnapshot: IMcpIntegrationSnapshot;

	constructor(
		options: IViewletViewOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IMcpIntegrationService private readonly integrationService: IMcpIntegrationService,
		@IContextConnectionService private readonly connectionService: IContextConnectionService,
		@ICommandService private readonly commandService: ICommandService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(
			options,
			keybindingService,
			contextMenuService,
			configurationService,
			contextKeyService,
			viewDescriptorService,
			instantiationService,
			openerService,
			themeService,
			hoverService
		);
		this.integrationSnapshot = this.integrationService.snapshot;
		this._register(this.integrationService.onDidChange(snapshot => this.renderSnapshot(snapshot)));
		this._register(this.connectionService.onDidChange(() => this.renderSnapshot(this.integrationSnapshot)));
	}

	override shouldShowWelcome(): boolean {
		return false;
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.content = dom.append(container, dom.$('.repobud-integrations'));
		this.renderSnapshot(this.integrationService.snapshot);
	}

	private renderSnapshot(snapshot: IMcpIntegrationSnapshot): void {
		if (!this.content) {
			return;
		}
		this.renderedDisposables.clear();
		dom.clearNode(this.content);
		this.integrationSnapshot = snapshot;
		this.renderContextHeader(snapshot);

		if (!snapshot.activeRepository) {
			this.renderEmptyState(localize(
				'repoBudIntegrationsNoActiveRepository',
				'Select a repository to see its effective MCP servers.'
			));
			return;
		}
		if (snapshot.loading) {
			this.renderEmptyState(localize('repoBudIntegrationsLoading', 'Loading MCP servers...'));
			return;
		}
		for (const error of snapshot.errors) {
			const element = dom.append(this.content, dom.$('.repobud-integrations-error'));
			element.textContent = error;
		}
		if (this.connectionService.snapshot.error) {
			const element = dom.append(this.content, dom.$('.repobud-integrations-error'));
			element.textContent = this.connectionService.snapshot.error;
		}
		if (!snapshot.globalRepository) {
			this.renderGlobalRepositoryPrompt();
		}

		this.renderSection('enabled', snapshot.sections.enabled);
		this.renderSection('available', snapshot.sections.available);
		this.renderSection('needsAttention', snapshot.sections.needsAttention);
	}

	private renderContextHeader(snapshot: IMcpIntegrationSnapshot): void {
		const header = dom.append(this.content!, dom.$('.repobud-integrations-context'));
		const eyebrow = dom.append(header, dom.$('.repobud-integrations-context-label'));
		eyebrow.textContent = localize('repoBudIntegrationsActiveRepository', 'Active repository');
		const name = dom.append(header, dom.$('.repobud-integrations-context-name'));
		name.textContent = snapshot.activeRepository ? basename(snapshot.activeRepository) : localize('none', 'None');
		if (snapshot.activeRepository) {
			const path = dom.append(header, dom.$('.repobud-integrations-context-path'));
			path.textContent = snapshot.activeRepository.fsPath;
			path.title = snapshot.activeRepository.fsPath;
		}
		const heading = dom.append(header, dom.$('h2.repobud-integrations-heading'));
		heading.textContent = localize('repoBudMcpServersHeading', 'MCP Servers');
	}

	private renderGlobalRepositoryPrompt(): void {
		const prompt = dom.append(this.content!, dom.$('.repobud-integrations-prompt'));
		const text = dom.append(prompt, dom.$('span'));
		text.textContent = localize(
			'repoBudIntegrationsNoGlobalRepository',
			'Global MCP definitions are unavailable until a configuration repository is selected.'
		);
		const button = dom.append(prompt, dom.$<HTMLButtonElement>('button.repobud-integrations-link'));
		button.type = 'button';
		button.textContent = localize('repoBudIntegrationsChooseGlobalRepository', 'Choose repository');
		this.renderedDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
			void this.commandService.executeCommand(MANAGE_CONFIGURATION_REPOSITORY_COMMAND_ID);
		}));
	}

	private renderSection(section: McpIntegrationSection, integrations: readonly IEffectiveMcpIntegration[]): void {
		const element = dom.append(this.content!, dom.$(`section.repobud-integrations-section.${section}`));
		const heading = dom.append(element, dom.$('h3.repobud-integrations-section-title'));
		dom.append(heading, dom.$('span')).textContent = sectionLabels[section];
		dom.append(heading, dom.$('span.repobud-integrations-count')).textContent =
			String(integrations.length);

		if (integrations.length === 0) {
			dom.append(element, dom.$('.repobud-integrations-section-empty')).textContent =
				localize('repoBudIntegrationsSectionEmpty', 'No MCP servers');
			return;
		}
		const list = dom.append(element, dom.$('.repobud-integrations-list'));
		list.setAttribute('role', 'list');
		list.setAttribute('aria-label', sectionLabels[section]);
		for (const integration of integrations) {
			this.renderIntegration(list, integration);
		}
	}

	private renderIntegration(list: HTMLElement, integration: IEffectiveMcpIntegration): void {
		const row = dom.append(list, dom.$('.repobud-integration-row'));
		row.setAttribute('role', 'listitem');
		row.dataset.integrationId = integration.id;

		const summary = dom.append(row, dom.$('.repobud-integration-summary'));
		dom.append(summary, dom.$('.repobud-integration-title')).textContent = integration.name;
		const badges = dom.append(summary, dom.$('.repobud-integration-badges'));
		if (integration.definition) {
			const transport = dom.append(
				badges,
				dom.$(`span.repobud-integration-transport.${integration.definition.transport.type}`)
			);
			transport.textContent = integration.definition.transport.type === 'stdio'
				? localize('repoBudIntegrationLocalTransport', 'Local process')
				: localize('repoBudIntegrationRemoteTransport', 'Remote endpoint');
		}
		for (const origin of integration.origins) {
			const badge = dom.append(badges, dom.$(`span.repobud-integration-origin.${origin}`));
			badge.textContent = originLabels[origin];
		}

		if (integration.description) {
			dom.append(row, dom.$('.repobud-integration-description')).textContent =
				integration.description;
		}
		if (integration.issue) {
			dom.append(row, dom.$('.repobud-integration-issue')).textContent = integration.issue;
		}
		this.renderClients(row, integration);
		this.renderActivation(row, integration);
		this.renderConnections(row, integration);
		this.renderHealth(row, integration);
		this.renderActions(row, integration);
	}

	private renderClients(row: HTMLElement, integration: IEffectiveMcpIntegration): void {
		const fieldset = dom.append(row, dom.$('fieldset.repobud-integration-clients'));
		dom.append(fieldset, dom.$('legend')).textContent =
			localize('repoBudIntegrationSelectedClients', 'Enabled clients');
		for (const client of ['codex', 'claude-code', 'cursor'] as const) {
			const label = dom.append(fieldset, dom.$('label.repobud-integration-client'));
			const input = dom.append(label, dom.$<HTMLInputElement>('input'));
			input.type = 'checkbox';
			input.checked = integration.clients.includes(client);
			input.disabled = integration.section === 'needsAttention';
			dom.append(label, dom.$('span')).textContent = clientLabels[client];
			this.renderedDisposables.add(dom.addDisposableListener(input, dom.EventType.CHANGE, () => {
				const clients = new Set(integration.clients);
				input.checked ? clients.add(client) : clients.delete(client);
				void this.updateOverride(integration, {
					...integration.repositoryOverride,
					clients: [...clients],
				});
			}));
		}
		if (integration.repositoryOverride?.clients) {
			const reset = dom.append(
				fieldset,
				dom.$<HTMLButtonElement>('button.repobud-integrations-link')
			);
			reset.type = 'button';
			reset.textContent = localize('repoBudIntegrationUseGlobalClients', 'Use global selection');
			this.renderedDisposables.add(dom.addDisposableListener(reset, dom.EventType.CLICK, () => {
				const { activation, connection } = integration.repositoryOverride ?? {};
				const setting = {
					...(activation ? { activation } : {}),
					...(connection ? { connection } : {}),
				};
				void this.updateOverride(
					integration,
					Object.keys(setting).length > 0 ? setting : undefined
				);
			}));
		}
		const projections = dom.append(row, dom.$('.repobud-integration-projections'));
		for (const projection of integration.projections) {
			const client = dom.append(projections, dom.$('.repobud-integration-projection'));
			const badge = dom.append(
				client,
				dom.$(`span.repobud-integration-projection-badge.${projection.state}`)
			);
			badge.textContent = `${clientLabels[projection.client]} · ${projection.state}`;
			if (projection.detail) {
				badge.title = projection.detail;
			}
			if (
				projection.client === 'claude-code' &&
				integration.activation === 'on' &&
				(projection.state === 'missing' || projection.state === 'conflict')
			) {
				this.renderAction(
					client,
					projection.state === 'conflict'
						? localize('repoBudIntegrationReplaceClaudeProjection', 'Replace')
						: localize('repoBudIntegrationProjectClaude', 'Project'),
					() => projection.state === 'conflict'
						? this.confirmProjectionReplace(integration)
						: this.integrationService.project(integration.id, 'claude-code')
				);
			}
		}
	}

	private async confirmProjectionReplace(integration: IEffectiveMcpIntegration): Promise<void> {
		const result = await this.dialogService.confirm({
			type: 'warning',
			message: localize(
				'repoBudIntegrationConfirmProjectionReplace',
				'Replace the existing Claude Code MCP entry?'
			),
			detail: localize(
				'repoBudIntegrationConfirmProjectionReplaceDetail',
				'Only the "{0}" entry in .mcp.json will be replaced. Other servers and unknown fields will be preserved.',
				integration.id
			),
			primaryButton: localize('repoBudIntegrationReplaceProjection', 'Replace entry'),
		});
		if (result.confirmed) {
			await this.integrationService.project(integration.id, 'claude-code', true);
		}
	}

	private renderActivation(row: HTMLElement, integration: IEffectiveMcpIntegration): void {
		const controls = dom.append(row, dom.$('.repobud-integration-overrides'));
		controls.setAttribute('role', 'group');
		controls.setAttribute('aria-label', localize(
			'repoBudIntegrationActivationOverride',
			'Repository activation override for {0}',
			integration.name
		));
		const current = integration.repositoryOverride?.activation ?? 'inherit';
		for (const value of ['inherit', 'on', 'off'] as const) {
			const button = dom.append(
				controls,
				dom.$<HTMLButtonElement>('button.repobud-integration-override')
			);
			button.type = 'button';
			button.textContent = value === 'inherit'
				? localize('repoBudIntegrationInherit', 'Inherit')
				: value === 'on'
					? localize('repoBudIntegrationOn', 'On')
					: localize('repoBudIntegrationOff', 'Off');
			button.disabled = integration.section === 'needsAttention';
			button.setAttribute('aria-pressed', String(current === value));
			button.classList.toggle('selected', current === value);
			this.renderedDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
				const { clients, connection } = integration.repositoryOverride ?? {};
				void this.updateOverride(
					integration,
					value === 'inherit'
						? clients || connection ? {
							...(clients ? { clients } : {}),
							...(connection ? { connection } : {}),
						} : undefined
						: {
							...(clients ? { clients } : {}),
							...(connection ? { connection } : {}),
							activation: value,
						}
				);
			}));
		}
	}

	private renderConnections(row: HTMLElement, integration: IEffectiveMcpIntegration): void {
		if (integration.definition?.connection?.provider !== 'github') {
			return;
		}
		const container = dom.append(row, dom.$('.repobud-integration-connections'));
		dom.append(container, dom.$('h4')).textContent =
			localize('repoBudGitHubConnections', 'GitHub Connections');
		const group = this.connectionService.snapshot.groups.find(
			candidate => candidate.integrationId === integration.id
		);
		if (!group) {
			dom.append(container, dom.$('.repobud-integration-connection-detail')).textContent =
				this.connectionService.snapshot.loading
					? localize('repoBudConnectionsLoading', 'Loading Connections...')
					: localize('repoBudConnectionsUnavailable', 'Connections are unavailable.');
			return;
		}
		if (group.issue) {
			const issue = dom.append(
				container,
				dom.$(`.repobud-integration-connection-issue.${group.state}`)
			);
			issue.textContent = group.issue;
		}
		for (const connection of group.connections) {
			this.renderConnection(container, integration, group, connection);
		}
		const actions = dom.append(container, dom.$('.repobud-integration-connection-actions'));
		this.renderAction(
			actions,
			localize('repoBudAddGitHubConnection', 'Connect GitHub account'),
			() => this.addGitHubConnection(integration)
		);
		if (group.selectionSource === 'repository') {
			this.renderAction(
				actions,
				localize('repoBudUseGlobalConnection', 'Use global default'),
				() => this.connectionService.setRepositoryConnection(integration.id, undefined)
			);
		}
	}

	private renderConnection(
		container: HTMLElement,
		integration: IEffectiveMcpIntegration,
		group: IEffectiveConnectionGroup,
		connection: IEffectiveConnectionGroup['connections'][number],
	): void {
		const row = dom.append(container, dom.$('.repobud-integration-connection'));
		const summary = dom.append(row, dom.$('.repobud-integration-connection-summary'));
		const label = dom.append(summary, dom.$('.repobud-integration-connection-label'));
		label.textContent = connection.accountLabel;
		const state = dom.append(
			summary,
			dom.$(`span.repobud-integration-connection-state.${connection.state}`)
		);
		state.textContent = connectionStateLabels[connection.state];
		const detail = dom.append(row, dom.$('.repobud-integration-connection-detail'));
		detail.textContent = connection.scopes.length > 0
			? localize(
				'repoBudGitHubConnectionScopes',
				'{0} · Scopes: {1}',
				connection.tenant,
				connection.scopes.join(', ')
			)
			: connection.tenant;
		const actions = dom.append(row, dom.$('.repobud-integration-connection-actions'));
		if (
			group.selectedConnectionId !== connection.id ||
			group.selectionSource !== 'repository'
		) {
			this.renderAction(
				actions,
				localize('repoBudUseConnectionForRepository', 'Use for repository'),
				() => this.connectionService.setRepositoryConnection(integration.id, connection.id)
			);
		} else {
			dom.append(actions, dom.$('.repobud-integration-connection-selected')).textContent =
				localize('repoBudConnectionSelectedForRepository', 'Selected for repository');
		}
		if (
			group.selectedConnectionId !== connection.id ||
			group.selectionSource !== 'global'
		) {
			this.renderAction(
				actions,
				localize('repoBudSetGlobalConnection', 'Set global default'),
				() => this.connectionService.setGlobalConnection(integration.id, connection.id)
			);
		}
		this.renderAction(
			actions,
			localize('repoBudValidateConnection', 'Validate'),
			() => this.connectionService.validateConnection(connection.id)
		);
		this.renderAction(
			actions,
			localize('repoBudDisconnectConnection', 'Disconnect'),
			() => this.confirmDisconnect(connection.id, connection.accountLabel)
		);
	}

	private async addGitHubConnection(integration: IEffectiveMcpIntegration): Promise<void> {
		const result = await this.dialogService.input({
			type: 'info',
			message: localize('repoBudConnectGitHubAccount', 'Connect a GitHub account'),
			detail: localize(
				'repoBudConnectGitHubAccountDetail',
				'Enter a GitHub token. It will be validated against GitHub and stored in macOS Keychain. It will not be written to either Git repository.'
			),
			inputs: [{
				type: 'password',
				placeholder: localize('repoBudGitHubTokenPlaceholder', 'GitHub token'),
			}],
			primaryButton: localize('repoBudConnectGitHubPrimaryButton', 'Connect'),
		});
		const token = result.values?.[0];
		if (result.confirmed && token) {
			await this.connectionService.addGitHubConnection(integration.id, token);
		}
	}

	private async confirmDisconnect(id: string, accountLabel: string): Promise<void> {
		const result = await this.dialogService.confirm({
			type: 'warning',
			message: localize(
				'repoBudConfirmDisconnectConnection',
				'Disconnect GitHub account "{0}"?',
				accountLabel
			),
			detail: localize(
				'repoBudConfirmDisconnectConnectionDetail',
				'The credential will be removed from macOS Keychain. The Integration, Plugin, and portable connection reference will not be deleted.'
			),
			primaryButton: localize('repoBudDisconnectPrimaryButton', 'Disconnect'),
		});
		if (result.confirmed) {
			await this.connectionService.disconnect(id);
		}
	}

	private renderHealth(row: HTMLElement, integration: IEffectiveMcpIntegration): void {
		const health = dom.append(
			row,
			dom.$(`.repobud-integration-health.${integration.health.state}`)
		);
		const label = dom.append(health, dom.$('span.repobud-integration-health-label'));
		label.textContent = healthLabels[integration.health.state];
		const details = [
			integration.health.protocolVersion
				? localize(
					'repoBudIntegrationProtocolVersion',
					'Protocol {0}',
					integration.health.protocolVersion
				)
				: undefined,
			integration.health.capabilities.length > 0
				? integration.health.capabilities.join(', ')
				: undefined,
			integration.health.detail,
		].filter(Boolean);
		if (details.length > 0) {
			const detail = dom.append(health, dom.$('.repobud-integration-health-detail'));
			detail.textContent = details.join(' · ');
		}
	}

	private renderActions(row: HTMLElement, integration: IEffectiveMcpIntegration): void {
		const actions = dom.append(row, dom.$('.repobud-integration-actions'));
		if (integration.definitionResource) {
			this.renderAction(actions, localize(
				'repoBudIntegrationRevealDefinition',
				'Reveal definition'
			), () => this.commandService.executeCommand('revealFileInOS', integration.definitionResource));
		}
		if (integration.definition && integration.section !== 'needsAttention') {
			const label = integration.health.state === 'checking'
				? localize('repoBudIntegrationCheckingHealth', 'Checking...')
				: localize('repoBudIntegrationCheckHealth', 'Check health');
			this.renderAction(actions, label, () => this.confirmAndCheckHealth(integration),
				integration.health.state === 'checking');
		}
	}

	private renderAction(
		container: HTMLElement,
		label: string,
		action: () => Promise<unknown>,
		disabled = false,
	): void {
		const button = dom.append(
			container,
			dom.$<HTMLButtonElement>('button.repobud-integration-action')
		);
		button.type = 'button';
		button.textContent = label;
		button.disabled = disabled;
		this.renderedDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
			void this.runAction(action);
		}));
	}

	private async confirmAndCheckHealth(integration: IEffectiveMcpIntegration): Promise<void> {
		if (integration.definition?.transport.type === 'stdio') {
			const command = integration.definition.transport.command;
			const args = JSON.stringify(integration.definition.transport.args);
			const result = await this.dialogService.confirm({
				type: 'warning',
				message: localize(
					'repoBudIntegrationConfirmLocalHealth',
					'Start this local MCP process to check its capabilities?'
				),
				detail: localize(
					'repoBudIntegrationConfirmLocalHealthDetail',
					'The app will run this process with a minimal environment and stop it after initialization. A shell will not be used.\n\nCommand: {0}\nArguments: {1}',
					command,
					args
				),
				primaryButton: localize('repoBudIntegrationStartAndCheck', 'Start and check'),
			});
			if (!result.confirmed) {
				return;
			}
		}
		await this.integrationService.checkHealth(integration.id);
	}

	private async updateOverride(
		integration: IEffectiveMcpIntegration,
		setting: ICanonicalIntegrationSetting | undefined,
	): Promise<void> {
		await this.runAction(() => this.integrationService.setRepositoryOverride(integration.id, setting));
	}

	private async runAction(action: () => Promise<unknown>): Promise<void> {
		try {
			await action();
		} catch (error) {
			this.notificationService.error(error instanceof Error ? error.message : String(error));
		}
	}

	private renderEmptyState(message: string): void {
		dom.append(this.content!, dom.$('.repobud-integrations-empty')).textContent = message;
	}
}
