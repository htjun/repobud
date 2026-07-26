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
} from '../../../../platform/repoBud/common/pluginPackage.js';
import { IContextPluginService } from '../common/pluginManagement.js';
import { REPOBUD_VIEW_CONTAINER_IDS } from '../common/repoBud.js';
import { MANAGE_CONFIGURATION_REPOSITORY_COMMAND_ID } from './canonicalConfigurationActions.js';

export const MANAGE_PLUGIN_LIBRARY_COMMAND_ID = 'repoBud.managePluginLibrary';
export const CHECK_PLUGIN_UPDATES_COMMAND_ID = 'repoBud.checkPluginUpdates';

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
	REPOBUD_VIEW_CONTAINER_IDS.skills,
	REPOBUD_VIEW_CONTAINER_IDS.integrations,
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
			title: localize2('repoBudManagePluginLibrary', 'Plugin Library...'),
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
			label: `$(folder-opened) ${localize('repoBudInstallLocalPlugin', 'Install from Local Directory...')}`,
			detail: localize(
				'repoBudInstallLocalPluginDetail',
				'Preview and copy an immutable snapshot into the configuration repository.'
			),
			kind: 'installLocal',
		}, {
			label: `$(git-branch) ${localize('repoBudInstallGitPlugin', 'Install from Git Source...')}`,
			detail: localize(
				'repoBudInstallGitPluginDetail',
				'Resolve a requested revision to an exact commit before installation.'
			),
			kind: 'installGit',
		}, ...pluginService.snapshot.installed.map(plugin => ({
			label: plugin.manifest.name,
			description: `${plugin.manifest.version} · ${plugin.enabled
				? localize('repoBudPluginEnabled', 'Enabled')
				: localize('repoBudPluginDisabled', 'Disabled')}`,
			detail: `${plugin.manifest.id} · ${plugin.source.type} · ${plugin.trusted
				? localize('repoBudPluginTrusted', 'Trusted')
				: localize('repoBudPluginUntrusted', 'Untrusted')}${plugin.localModified
					? ` · ${localize('repoBudPluginLocallyModified', 'Locally modified')}`
					: ''}`,
			kind: 'installed' as const,
			plugin,
		}))];
		const picked = await quickInputService.pick(items, {
			title: localize('repoBudPluginLibraryTitle', 'Plugin Library'),
			placeHolder: localize(
				'repoBudPluginLibraryPlaceholder',
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
			title: localize2('repoBudCheckPluginUpdates', 'Plugin Updates...'),
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
					'repoBudNoPluginUpdates',
					'No Plugin updates are available from the recorded sources.'
				));
				return;
			}
			const picked = await quickInputService.pick<IPluginUpdateItem>(
				pluginService.snapshot.updates.map(update => ({
					label: update.installed.manifest.name,
					description: `${update.installed.manifest.version} → ${update.preview.manifest.version}`,
					detail: `${update.changes.length} changed files${update.installed.localModified
						? ` · ${localize('repoBudPluginUpdateDiverged', 'local changes detected')}`
						: ''}`,
					pluginId: update.installed.manifest.id,
				})),
				{
					title: localize('repoBudPluginUpdatesTitle', 'Plugin Updates'),
					placeHolder: localize(
						'repoBudPluginUpdatesPlaceholder',
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
					'repoBudPluginUpdatePreview',
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
						'repoBudTrustPluginUpdate',
						'I trust the executable content in this exact update'
					),
					checked: false,
				} : undefined,
				buttons: [{
					label: localize('repoBudApplyPluginUpdate', 'Apply'),
					run: () => 'apply',
				}, {
					label: localize('repoBudMergePluginUpdate', 'Merge'),
					run: () => 'merge',
				}, {
					label: localize('repoBudForkPluginUpdate', 'Fork local version'),
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
					'repoBudPluginMergeConflicts',
					'Merge was not applied. Conflicting files: {0}',
					result.conflicts.join(', ')
				));
			} else if (result.forkedPluginId) {
				notificationService.info(localize(
					'repoBudPluginForkCreated',
					'Created disabled local fork "{0}". The original Plugin was not changed.',
					result.forkedPluginId
				));
			} else {
				notificationService.info(localize(
					'repoBudPluginUpdateApplied',
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
		title: localize('repoBudChooseLocalPlugin', 'Choose Plugin Directory'),
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
		title: localize('repoBudGitPluginUrlTitle', 'Install Plugin from Git'),
		placeHolder: localize(
			'repoBudGitPluginUrlPlaceholder',
			'Absolute local repository path, HTTPS URL, or SSH URL'
		),
		prompt: localize(
			'repoBudGitPluginUrlPrompt',
			'Credential-bearing URLs are rejected. Existing Git credential helpers may be used.'
		),
	});
	if (!url) {
		return;
	}
	const revision = await quickInputService.input({
		title: localize('repoBudGitPluginRevisionTitle', 'Git Revision'),
		value: 'main',
		placeHolder: localize(
			'repoBudGitPluginRevisionPlaceholder',
			'Branch, tag, or full commit'
		),
		prompt: localize(
			'repoBudGitPluginRevisionPrompt',
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
			'repoBudInstallPluginPreview',
			'Install Plugin "{0}"?',
			preview.manifest.name
		),
		detail: formatInstallPreview(preview),
		primaryButton: localize('repoBudInstallPluginButton', 'Install'),
		checkbox: preview.trustRequired ? {
			label: localize(
				'repoBudTrustPluginContent',
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
			'repoBudPluginInstalled',
			'Plugin installed. Review and commit the configuration repository when ready.'
		)
		: localize(
			'repoBudPluginInstalledDisabled',
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
			label: `$(shield) ${localize('repoBudTrustPlugin', 'Trust current content...')}`,
			detail: localize(
				'repoBudTrustPluginDetail',
				'Bind executable trust to the current content hash.'
			),
			action: 'trust',
		});
	}
	actions.push(plugin.enabled ? {
		label: `$(circle-slash) ${localize('repoBudDisablePlugin', 'Disable Plugin')}`,
		detail: localize(
			'repoBudDisablePluginDetail',
			'Retain package files and Connections; make owned capabilities unavailable.'
		),
		action: 'disable',
	} : {
		label: `$(check) ${localize('repoBudEnablePlugin', 'Enable Plugin')}`,
		detail: localize(
			'repoBudEnablePluginDetail',
			'Enable the package. Skill and Integration activation remains separately configurable.'
		),
		action: 'enable',
	}, {
		label: `$(trash) ${localize('repoBudUninstallPlugin', 'Uninstall Plugin...')}`,
		detail: localize(
			'repoBudUninstallPluginDetail',
			'Remove package files. Shared Connections remain installed.'
		),
		action: 'uninstall',
	});
	const picked = await services.quickInputService.pick(actions, {
		title: plugin.manifest.name,
		placeHolder: localize(
			'repoBudPluginActionPlaceholder',
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
				'repoBudTrustInstalledPlugin',
				'Trust executable content in "{0}"?',
				plugin.manifest.name
			),
			detail: localize(
				'repoBudTrustInstalledPluginDetail',
				'Trust applies only to content hash {0}. Any local change or update invalidates it.',
				plugin.currentContentHash
			),
			primaryButton: localize('repoBudTrustPluginButton', 'Trust'),
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
				'repoBudConfirmPluginUninstall',
				'Uninstall Plugin "{0}"?',
				plugin.manifest.name
			),
			detail: `${plugin.manifest.skills.length} Skills · ${plugin.manifest.integrations.length} Integrations · ${plugin.manifest.connections.length} Connection requirements${plugin.localModified
				? `\n${localize('repoBudUninstallLocalChanges', 'This Plugin has local changes.')}`
				: ''}\n${localize(
					'repoBudUninstallKeepsConnections',
					'Connections and their Keychain credentials will not be deleted.'
				)}`,
			primaryButton: localize('repoBudUninstallPluginButton', 'Uninstall'),
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
		`${localize('repoBudPluginPreviewSource', 'Source')}: ${formatSource(preview)}`,
		`${localize('repoBudPluginPreviewVersion', 'Version')}: ${preview.manifest.version}`,
		`${localize('repoBudPluginPreviewLicense', 'License')}: ${preview.manifest.license}`,
		`${localize('repoBudPluginPreviewHash', 'Content hash')}: ${preview.contentHash}`,
		`${localize('repoBudPluginPreviewSkills', 'Skills')}: ${formatList(preview.manifest.skills)}`,
		`${localize('repoBudPluginPreviewIntegrations', 'MCP Integrations')}: ${formatList(preview.manifest.integrations)}`,
		`${localize('repoBudPluginPreviewScripts', 'Executable scripts')}: ${formatList(preview.manifest.scripts)}`,
		`${localize('repoBudPluginPreviewConnections', 'Connection requirements')}: ${formatList(preview.manifest.connections.map(connection => connection.provider))}`,
	].join('\n');
}

function formatUpdatePreview(
	preview: IPluginPackagePreview,
	installedVersion: string,
	changes: readonly { path: string; kind: string }[],
	locallyModified: boolean,
): string {
	return [
		`${localize('repoBudPluginInstalledVersion', 'Installed version')}: ${installedVersion}`,
		formatInstallPreview(preview),
		'',
		`${localize('repoBudPluginPreviewChanges', 'Changes')}: ${changes.map(change =>
			`${change.kind} ${change.path}`
		).join(', ')}`,
		locallyModified
			? localize(
				'repoBudPluginPreviewLocalChangesWarning',
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
		: localize('repoBudPluginPreviewNone', 'None');
}
