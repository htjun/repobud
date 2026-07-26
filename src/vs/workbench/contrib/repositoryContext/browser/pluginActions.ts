/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import {
	IQuickInputService,
	IQuickPickItem,
} from '../../../../platform/quickinput/common/quickInput.js';
import {
	IInstalledPluginPackage,
	IPluginPackagePreview,
	IPluginSourceRequest,
	PluginUpdateStrategy,
} from '../../../../platform/repositoryContext/common/pluginPackage.js';
import { IContextPluginService } from '../common/pluginManagement.js';
import { REPOSITORY_CONTEXT_VIEW_CONTAINER_IDS } from '../common/repositoryContext.js';
import { MANAGE_CONFIGURATION_REPOSITORY_COMMAND_ID } from './canonicalConfigurationActions.js';

export const MANAGE_PLUGIN_LIBRARY_COMMAND_ID = 'repositoryContext.managePluginLibrary';
export const CHECK_PLUGIN_UPDATES_COMMAND_ID = 'repositoryContext.checkPluginUpdates';

interface IPluginLibraryItem extends IQuickPickItem {
	readonly kind: 'installLocal' | 'installGit' | 'installed';
	readonly plugin?: IInstalledPluginPackage;
}

interface IPluginActionItem extends IQuickPickItem {
	readonly action: 'enable' | 'disable' | 'trust' | 'uninstall';
}

interface IPluginUpdateItem extends IQuickPickItem {
	readonly pluginId: string;
}

interface IPluginActionServices {
	readonly dialogService: IDialogService;
	readonly fileDialogService: IFileDialogService;
	readonly notificationService: INotificationService;
	readonly quickInputService: IQuickInputService;
}

const pluginMenus = [
	REPOSITORY_CONTEXT_VIEW_CONTAINER_IDS.skills,
	REPOSITORY_CONTEXT_VIEW_CONTAINER_IDS.integrations,
].map(viewContainer => ({
	id: MenuId.ViewContainerTitle,
	group: '2_plugins',
	order: 120,
	when: ContextKeyExpr.equals('viewContainer', viewContainer),
}));

registerAction2(class ManagePluginLibraryAction extends Action2 {
	constructor() {
		super({
			id: MANAGE_PLUGIN_LIBRARY_COMMAND_ID,
			title: localize2('repositoryContextManagePluginLibrary', 'Plugin Library...'),
			icon: Codicon.library,
			f1: false,
			menu: pluginMenus,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const pluginService = accessor.get(IContextPluginService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);
		const commandService = accessor.get(ICommandService);
		const services: IPluginActionServices = {
			dialogService: accessor.get(IDialogService),
			fileDialogService: accessor.get(IFileDialogService),
			notificationService,
			quickInputService,
		};
		if (!pluginService.snapshot.globalRepository) {
			await commandService.executeCommand(MANAGE_CONFIGURATION_REPOSITORY_COMMAND_ID);
			return;
		}
		const items: IPluginLibraryItem[] = [{
			label: `$(folder-opened) ${localize('repositoryContextInstallLocalPlugin', 'Install from Local Directory...')}`,
			detail: localize(
				'repositoryContextInstallLocalPluginDetail',
				'Preview and copy an immutable snapshot into the configuration repository.'
			),
			kind: 'installLocal',
		}, {
			label: `$(git-branch) ${localize('repositoryContextInstallGitPlugin', 'Install from Git Source...')}`,
			detail: localize(
				'repositoryContextInstallGitPluginDetail',
				'Resolve a requested revision to an exact commit before installation.'
			),
			kind: 'installGit',
		}, ...pluginService.snapshot.installed.map(plugin => ({
			label: plugin.manifest.name,
			description: `${plugin.manifest.version} · ${plugin.enabled
				? localize('repositoryContextPluginEnabled', 'Enabled')
				: localize('repositoryContextPluginDisabled', 'Disabled')}`,
			detail: `${plugin.manifest.id} · ${plugin.source.type} · ${plugin.trusted
				? localize('repositoryContextPluginTrusted', 'Trusted')
				: localize('repositoryContextPluginUntrusted', 'Untrusted')}${plugin.localModified
					? ` · ${localize('repositoryContextPluginLocallyModified', 'Locally modified')}`
					: ''}`,
			kind: 'installed' as const,
			plugin,
		}))];
		const picked = await quickInputService.pick(items, {
			title: localize('repositoryContextPluginLibraryTitle', 'Plugin Library'),
			placeHolder: localize(
				'repositoryContextPluginLibraryPlaceholder',
				'Install a Plugin or manage an installed package'
			),
			matchOnDescription: true,
			matchOnDetail: true,
		});
		if (!picked) {
			return;
		}
		try {
			if (picked.kind === 'installLocal') {
				await installLocalPlugin(services, pluginService);
			} else if (picked.kind === 'installGit') {
				await installGitPlugin(services, pluginService);
			} else if (picked.plugin) {
				await manageInstalledPlugin(services, pluginService, picked.plugin);
			}
		} catch (error) {
			notificationService.error(error instanceof Error ? error.message : String(error));
		}
	}
});

registerAction2(class CheckPluginUpdatesAction extends Action2 {
	constructor() {
		super({
			id: CHECK_PLUGIN_UPDATES_COMMAND_ID,
			title: localize2('repositoryContextCheckPluginUpdates', 'Plugin Updates...'),
			icon: Codicon.sync,
			f1: false,
			menu: pluginMenus.map(menu => ({ ...menu, order: 121 })),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const pluginService = accessor.get(IContextPluginService);
		const notificationService = accessor.get(INotificationService);
		const quickInputService = accessor.get(IQuickInputService);
		const commandService = accessor.get(ICommandService);
		const dialogService = accessor.get(IDialogService);
		if (!pluginService.snapshot.globalRepository) {
			await commandService.executeCommand(MANAGE_CONFIGURATION_REPOSITORY_COMMAND_ID);
			return;
		}
		try {
			await pluginService.refresh(true);
			if (pluginService.snapshot.updates.length === 0) {
				notificationService.info(localize(
					'repositoryContextNoPluginUpdates',
					'No Plugin updates are available from the recorded sources.'
				));
				return;
			}
			const picked = await quickInputService.pick<IPluginUpdateItem>(
				pluginService.snapshot.updates.map(update => ({
					label: update.installed.manifest.name,
					description: `${update.installed.manifest.version} → ${update.preview.manifest.version}`,
					detail: `${update.changes.length} changed files${update.installed.localModified
						? ` · ${localize('repositoryContextPluginUpdateDiverged', 'local changes detected')}`
						: ''}`,
					pluginId: update.installed.manifest.id,
				})),
				{
					title: localize('repositoryContextPluginUpdatesTitle', 'Plugin Updates'),
					placeHolder: localize(
						'repositoryContextPluginUpdatesPlaceholder',
						'Choose an update to review'
					),
					matchOnDescription: true,
					matchOnDetail: true,
				}
			);
			if (!picked) {
				return;
			}
			const update = pluginService.snapshot.updates.find(candidate =>
				candidate.installed.manifest.id === picked.pluginId
			);
			if (!update) {
				return;
			}
			const prompt = await dialogService.prompt<PluginUpdateStrategy>({
				type: 'warning',
				message: localize(
					'repositoryContextPluginUpdatePreview',
					'Review update for "{0}"',
					update.installed.manifest.name
				),
				detail: formatUpdatePreview(
					update.preview,
					update.installed.manifest.version,
					update.changes,
					update.installed.localModified
				),
				checkbox: update.preview.trustRequired ? {
					label: localize(
						'repositoryContextTrustPluginUpdate',
						'I trust the executable content in this exact update'
					),
					checked: false,
				} : undefined,
				buttons: [{
					label: localize('repositoryContextApplyPluginUpdate', 'Apply'),
					run: () => 'apply',
				}, {
					label: localize('repositoryContextMergePluginUpdate', 'Merge'),
					run: () => 'merge',
				}, {
					label: localize('repositoryContextForkPluginUpdate', 'Fork local version'),
					run: () => 'fork',
				}],
				cancelButton: true,
			});
			if (!prompt.result) {
				return;
			}
			const result = await pluginService.applyUpdate(
				update.installed.manifest.id,
				prompt.result,
				update.preview.contentHash,
				Boolean(prompt.checkboxChecked)
			);
			if (result.conflicts?.length) {
				notificationService.warn(localize(
					'repositoryContextPluginMergeConflicts',
					'Merge was not applied. Conflicting files: {0}',
					result.conflicts.join(', ')
				));
			} else if (result.forkedPluginId) {
				notificationService.info(localize(
					'repositoryContextPluginForkCreated',
					'Created disabled local fork "{0}". The original Plugin was not changed.',
					result.forkedPluginId
				));
			} else {
				notificationService.info(localize(
					'repositoryContextPluginUpdateApplied',
					'Plugin update applied. Review and commit the configuration repository when ready.'
				));
			}
		} catch (error) {
			notificationService.error(error instanceof Error ? error.message : String(error));
		}
	}
});

async function installLocalPlugin(
	services: IPluginActionServices,
	pluginService: IContextPluginService,
): Promise<void> {
	const roots = await services.fileDialogService.showOpenDialog({
		title: localize('repositoryContextChooseLocalPlugin', 'Choose Plugin Directory'),
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
	});
	if (roots?.[0]) {
		await previewAndInstall(services, pluginService, { type: 'local', location: roots[0] });
	}
}

async function installGitPlugin(
	services: IPluginActionServices,
	pluginService: IContextPluginService,
): Promise<void> {
	const quickInputService = services.quickInputService;
	const url = await quickInputService.input({
		title: localize('repositoryContextGitPluginUrlTitle', 'Install Plugin from Git'),
		placeHolder: localize(
			'repositoryContextGitPluginUrlPlaceholder',
			'Absolute local repository path, HTTPS URL, or SSH URL'
		),
		prompt: localize(
			'repositoryContextGitPluginUrlPrompt',
			'Credential-bearing URLs are rejected. Existing Git credential helpers may be used.'
		),
	});
	if (!url) {
		return;
	}
	const revision = await quickInputService.input({
		title: localize('repositoryContextGitPluginRevisionTitle', 'Git Revision'),
		value: 'main',
		placeHolder: localize(
			'repositoryContextGitPluginRevisionPlaceholder',
			'Branch, tag, or full commit'
		),
		prompt: localize(
			'repositoryContextGitPluginRevisionPrompt',
			'The installed package records the exact resolved commit.'
		),
	});
	if (revision) {
		await previewAndInstall(services, pluginService, {
			type: 'git',
			url,
			revision,
		});
	}
}

async function previewAndInstall(
	services: IPluginActionServices,
	pluginService: IContextPluginService,
	source: IPluginSourceRequest,
): Promise<void> {
	const preview = await pluginService.preview(source);
	const confirmation = await services.dialogService.confirm({
		type: preview.trustRequired ? 'warning' : 'info',
		message: localize(
			'repositoryContextInstallPluginPreview',
			'Install Plugin "{0}"?',
			preview.manifest.name
		),
		detail: formatInstallPreview(preview),
		primaryButton: localize('repositoryContextInstallPluginButton', 'Install'),
		checkbox: preview.trustRequired ? {
			label: localize(
				'repositoryContextTrustPluginContent',
				'I trust the executable content in this exact package'
			),
			checked: false,
		} : undefined,
	});
	if (!confirmation.confirmed) {
		return;
	}
	const installed = await pluginService.install(
		source,
		preview.contentHash,
		Boolean(confirmation.checkboxChecked)
	);
	services.notificationService.info(installed.enabled
		? localize(
			'repositoryContextPluginInstalled',
			'Plugin installed. Review and commit the configuration repository when ready.'
		)
		: localize(
			'repositoryContextPluginInstalledDisabled',
			'Plugin installed disabled. Grant trust before enabling its executable content.'
		));
}

async function manageInstalledPlugin(
	services: IPluginActionServices,
	pluginService: IContextPluginService,
	plugin: IInstalledPluginPackage,
): Promise<void> {
	const actions: IPluginActionItem[] = [];
	if (!plugin.trusted) {
		actions.push({
			label: `$(shield) ${localize('repositoryContextTrustPlugin', 'Trust current content...')}`,
			detail: localize(
				'repositoryContextTrustPluginDetail',
				'Bind executable trust to the current content hash.'
			),
			action: 'trust',
		});
	}
	actions.push(plugin.enabled ? {
		label: `$(circle-slash) ${localize('repositoryContextDisablePlugin', 'Disable Plugin')}`,
		detail: localize(
			'repositoryContextDisablePluginDetail',
			'Retain package files and Connections; make owned capabilities unavailable.'
		),
		action: 'disable',
	} : {
		label: `$(check) ${localize('repositoryContextEnablePlugin', 'Enable Plugin')}`,
		detail: localize(
			'repositoryContextEnablePluginDetail',
			'Enable the package. Skill and Integration activation remains separately configurable.'
		),
		action: 'enable',
	}, {
		label: `$(trash) ${localize('repositoryContextUninstallPlugin', 'Uninstall Plugin...')}`,
		detail: localize(
			'repositoryContextUninstallPluginDetail',
			'Remove package files. Shared Connections remain installed.'
		),
		action: 'uninstall',
	});
	const picked = await services.quickInputService.pick(actions, {
		title: plugin.manifest.name,
		placeHolder: localize(
			'repositoryContextPluginActionPlaceholder',
			'Choose a package lifecycle action'
		),
		matchOnDetail: true,
	});
	if (!picked) {
		return;
	}
	if (picked.action === 'trust') {
		const confirmation = await services.dialogService.confirm({
			type: 'warning',
			message: localize(
				'repositoryContextTrustInstalledPlugin',
				'Trust executable content in "{0}"?',
				plugin.manifest.name
			),
			detail: localize(
				'repositoryContextTrustInstalledPluginDetail',
				'Trust applies only to content hash {0}. Any local change or update invalidates it.',
				plugin.currentContentHash
			),
			primaryButton: localize('repositoryContextTrustPluginButton', 'Trust'),
		});
		if (confirmation.confirmed) {
			await pluginService.grantTrust(plugin.manifest.id);
		}
		return;
	}
	if (picked.action === 'uninstall') {
		const confirmation = await services.dialogService.confirm({
			type: 'warning',
			message: localize(
				'repositoryContextConfirmPluginUninstall',
				'Uninstall Plugin "{0}"?',
				plugin.manifest.name
			),
			detail: `${plugin.manifest.skills.length} Skills · ${plugin.manifest.integrations.length} Integrations · ${plugin.manifest.connections.length} Connection requirements${plugin.localModified
				? `\n${localize('repositoryContextUninstallLocalChanges', 'This Plugin has local changes.')}`
				: ''}\n${localize(
					'repositoryContextUninstallKeepsConnections',
					'Connections and their Keychain credentials will not be deleted.'
				)}`,
			primaryButton: localize('repositoryContextUninstallPluginButton', 'Uninstall'),
		});
		if (confirmation.confirmed) {
			await pluginService.uninstall(plugin.manifest.id);
		}
		return;
	}
	await pluginService.setEnabled(plugin.manifest.id, picked.action === 'enable');
}

function formatInstallPreview(preview: IPluginPackagePreview): string {
	return [
		`${localize('repositoryContextPluginPreviewSource', 'Source')}: ${formatSource(preview)}`,
		`${localize('repositoryContextPluginPreviewVersion', 'Version')}: ${preview.manifest.version}`,
		`${localize('repositoryContextPluginPreviewLicense', 'License')}: ${preview.manifest.license}`,
		`${localize('repositoryContextPluginPreviewHash', 'Content hash')}: ${preview.contentHash}`,
		`${localize('repositoryContextPluginPreviewSkills', 'Skills')}: ${formatList(preview.manifest.skills)}`,
		`${localize('repositoryContextPluginPreviewIntegrations', 'MCP Integrations')}: ${formatList(preview.manifest.integrations)}`,
		`${localize('repositoryContextPluginPreviewScripts', 'Executable scripts')}: ${formatList(preview.manifest.scripts)}`,
		`${localize('repositoryContextPluginPreviewConnections', 'Connection requirements')}: ${formatList(preview.manifest.connections.map(connection => connection.provider))}`,
	].join('\n');
}

function formatUpdatePreview(
	preview: IPluginPackagePreview,
	installedVersion: string,
	changes: readonly { path: string; kind: string }[],
	locallyModified: boolean,
): string {
	return [
		`${localize('repositoryContextPluginInstalledVersion', 'Installed version')}: ${installedVersion}`,
		formatInstallPreview(preview),
		'',
		`${localize('repositoryContextPluginPreviewChanges', 'Changes')}: ${changes.map(change =>
			`${change.kind} ${change.path}`
		).join(', ')}`,
		locallyModified
			? localize(
				'repositoryContextPluginPreviewLocalChangesWarning',
				'Local changes are present. Apply replaces them, Merge performs a three-way merge, and Fork preserves them as a disabled local package.'
			)
			: '',
	].filter(Boolean).join('\n');
}

function formatSource(preview: IPluginPackagePreview): string {
	if (preview.source.type === 'local') {
		return preview.source.label;
	}
	if (preview.source.type === 'git') {
		const location = preview.source.locationType === 'local'
			? preview.source.label
			: preview.source.url;
		return `${location} @ ${preview.source.requestedRevision} (${preview.source.revision})`;
	}
	return `${preview.source.pluginId} fork (${preview.source.contentHash})`;
}

function formatList(values: readonly string[]): string {
	return values.length > 0
		? values.join(', ')
		: localize('repositoryContextPluginPreviewNone', 'None');
}
