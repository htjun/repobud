/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, isEqual } from '../../../../base/common/resources.js';
import Severity from '../../../../base/common/severity.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { REPOSITORY_CONTEXT_VIEW_CONTAINER_IDS } from '../common/repositoryContext.js';
import { IRepositoryCatalogEntry, IRepositoryCatalogService } from '../common/repositoryCatalog.js';

export const SWITCH_REPOSITORY_COMMAND_ID = 'repositoryContext.switchRepository';
export const OPEN_REPOSITORY_COMMAND_ID = 'repositoryContext.openRepository';
export const CLONE_REPOSITORY_COMMAND_ID = 'repositoryContext.cloneRepository';
export const INITIALIZE_REPOSITORY_COMMAND_ID = 'repositoryContext.initializeRepository';

interface IRepositoryQuickPickItem extends IQuickPickItem {
	readonly entry?: IRepositoryCatalogEntry;
	readonly commandId?: string;
}

const removeButton = {
	iconClass: ThemeIcon.asClassName(Codicon.close),
	tooltip: localize('repositoryContextRemoveRepository', 'Remove from repository list'),
};

const primaryViewContainerWhen = ContextKeyExpr.or(
	...Object.values(REPOSITORY_CONTEXT_VIEW_CONTAINER_IDS)
		.map(id => ContextKeyExpr.equals('viewContainer', id))
)!;

function repositoryItem(entry: IRepositoryCatalogEntry, activeRepository: URI | undefined): IRepositoryQuickPickItem {
	const active = activeRepository ? isEqual(entry.uri, activeRepository) : false;
	const statusIcon = entry.availability === 'ready' ? '' : '$(warning) ';
	return {
		label: `${active ? '$(check) ' : ''}${statusIcon}${basename(entry.uri)}`,
		description: entry.uri.fsPath,
		detail: entry.availability === 'missing'
			? localize('repositoryContextMissingRepository', 'Repository folder is missing.')
			: entry.availability === 'notRepository'
				? localize('repositoryContextInvalidRepository', 'Folder is not a Git repository.')
				: undefined,
		entry,
		buttons: [removeButton],
	};
}

async function activateRepository(
	catalogService: IRepositoryCatalogService,
	notificationService: INotificationService,
	hostService: IHostService,
	entry: IRepositoryCatalogEntry,
): Promise<void> {
	if (entry.availability !== 'ready') {
		const message = entry.availability === 'missing'
			? localize('repositoryContextMissingRepositoryMessage', 'The repository folder no longer exists: {0}', entry.uri.fsPath)
			: localize('repositoryContextInvalidRepositoryMessage', 'The selected folder is not a Git repository: {0}', entry.uri.fsPath);
		notificationService.prompt(Severity.Warning, message, [{
			label: localize('repositoryContextRemoveInvalidRepository', 'Remove from List'),
			run: () => catalogService.remove(entry.uri),
		}]);
		return;
	}

	await hostService.openWindow(
		[{ folderUri: entry.uri }],
		{ forceReuseWindow: true }
	);
}

async function addAndActivate(
	catalogService: IRepositoryCatalogService,
	notificationService: INotificationService,
	hostService: IHostService,
	uri: URI,
): Promise<void> {
	const entry = await catalogService.add(uri);
	await activateRepository(catalogService, notificationService, hostService, entry);
}

async function showRepositoryPicker(accessor: ServicesAccessor): Promise<void> {
	const catalogService = accessor.get(IRepositoryCatalogService);
	const quickInputService = accessor.get(IQuickInputService);
	const notificationService = accessor.get(INotificationService);
	const commandService = accessor.get(ICommandService);
	const hostService = accessor.get(IHostService);

	await catalogService.refresh();
	const items: IRepositoryQuickPickItem[] = [
		...catalogService.entries.map(entry => repositoryItem(entry, catalogService.activeRepository)),
		{
			label: localize('repositoryContextOpenRepositoryPickerItem', '$(folder-opened) Open Existing Repository...'),
			commandId: OPEN_REPOSITORY_COMMAND_ID,
			alwaysShow: true,
		},
		{
			label: localize('repositoryContextCloneRepositoryPickerItem', '$(repo-clone) Clone Repository...'),
			commandId: CLONE_REPOSITORY_COMMAND_ID,
			alwaysShow: true,
		},
		{
			label: localize('repositoryContextInitializeRepositoryPickerItem', '$(repo-create) Initialize Repository...'),
			commandId: INITIALIZE_REPOSITORY_COMMAND_ID,
			alwaysShow: true,
		},
	];

	const picked = await quickInputService.pick(items, {
		title: localize('repositoryContextPickerTitle', 'Active Repository'),
		placeHolder: localize('repositoryContextPickerPlaceholder', 'Select one repository for Source Control, Skills, and Integrations'),
		matchOnDescription: true,
		matchOnDetail: true,
		activeItem: items.find(item => item.entry && catalogService.activeRepository && isEqual(item.entry.uri, catalogService.activeRepository)),
		onDidTriggerItemButton: ({ item, removeItem }) => {
			if (!item.entry) {
				return;
			}
			catalogService.remove(item.entry.uri);
			removeItem();
			notificationService.info(localize('repositoryContextRepositoryRemoved', 'Removed {0} from the repository list. Files were not changed.', item.entry.uri.fsPath));
			if (catalogService.activeRepository && isEqual(item.entry.uri, catalogService.activeRepository)) {
				void hostService.openWindow({ forceReuseWindow: true });
			}
		},
	});

	if (picked?.entry) {
		await activateRepository(catalogService, notificationService, hostService, picked.entry);
	} else if (picked?.commandId) {
		await commandService.executeCommand(picked.commandId);
	}
}

registerAction2(class SwitchRepositoryAction extends Action2 {
	constructor() {
		super({
			id: SWITCH_REPOSITORY_COMMAND_ID,
			title: localize2('repositoryContextSwitchRepository', 'Switch Repository'),
			icon: Codicon.repo,
			f1: false,
			menu: {
				id: MenuId.ViewContainerTitle,
				group: 'navigation',
				order: -100,
				when: primaryViewContainerWhen,
			},
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return showRepositoryPicker(accessor);
	}
});

registerAction2(class OpenRepositoryAction extends Action2 {
	constructor() {
		super({
			id: OPEN_REPOSITORY_COMMAND_ID,
			title: localize2('repositoryContextOpenRepository', 'Open Existing Repository'),
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const fileDialogService = accessor.get(IFileDialogService);
		const catalogService = accessor.get(IRepositoryCatalogService);
		const notificationService = accessor.get(INotificationService);
		const hostService = accessor.get(IHostService);
		const uris = await fileDialogService.showOpenDialog({
			title: localize('repositoryContextOpenRepositoryDialogTitle', 'Open Existing Repository'),
			openLabel: localize('repositoryContextOpenRepositoryDialogLabel', 'Open Repository'),
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
		});
		if (uris?.[0]) {
			await addAndActivate(catalogService, notificationService, hostService, uris[0]);
		}
	}
});

registerAction2(class CloneRepositoryAction extends Action2 {
	constructor() {
		super({
			id: CLONE_REPOSITORY_COMMAND_ID,
			title: localize2('repositoryContextCloneRepository', 'Clone Repository'),
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);
		const catalogService = accessor.get(IRepositoryCatalogService);
		const notificationService = accessor.get(INotificationService);
		const hostService = accessor.get(IHostService);
		const repositoryPath = await commandService.executeCommand<string | undefined>(
			'git.clone',
			undefined,
			undefined,
			{ postCloneAction: 'none' }
		);
		if (repositoryPath) {
			await addAndActivate(catalogService, notificationService, hostService, URI.file(repositoryPath));
		}
	}
});

registerAction2(class InitializeRepositoryAction extends Action2 {
	constructor() {
		super({
			id: INITIALIZE_REPOSITORY_COMMAND_ID,
			title: localize2('repositoryContextInitializeRepository', 'Initialize Repository'),
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const fileDialogService = accessor.get(IFileDialogService);
		const commandService = accessor.get(ICommandService);
		const catalogService = accessor.get(IRepositoryCatalogService);
		const notificationService = accessor.get(INotificationService);
		const hostService = accessor.get(IHostService);
		const uris = await fileDialogService.showOpenDialog({
			title: localize('repositoryContextInitializeRepositoryDialogTitle', 'Initialize Repository'),
			openLabel: localize('repositoryContextInitializeRepositoryDialogLabel', 'Initialize Repository'),
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
		});
		if (!uris?.[0]) {
			return;
		}

		const repositoryPath = await commandService.executeCommand<string | undefined>(
			'_git.initRepository',
			uris[0].fsPath
		);
		if (repositoryPath) {
			await addAndActivate(catalogService, notificationService, hostService, URI.file(repositoryPath));
		}
	}
});
