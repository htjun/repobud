/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { ICanonicalConfigurationService } from '../common/canonicalConfiguration.js';
import { REPOBUD_VIEW_CONTAINER_IDS } from '../common/repoBud.js';

export const MANAGE_CONFIGURATION_REPOSITORY_COMMAND_ID = 'repoBud.manageConfigurationRepository';

interface IConfigurationRepositoryActionArgs {
	readonly action?: 'select' | 'initialize';
	readonly uri?: string;
}

interface IConfigurationRepositoryQuickPickItem extends IQuickPickItem {
	readonly action?: 'select' | 'initialize';
}

const primaryViewContainerWhen = ContextKeyExpr.or(
	...Object.values(REPOBUD_VIEW_CONTAINER_IDS)
		.map(id => ContextKeyExpr.equals('viewContainer', id))
)!;

async function pickRepositoryFolder(
	fileDialogService: IFileDialogService,
	action: 'select' | 'initialize',
): Promise<URI | undefined> {
	const selecting = action === 'select';
	const uris = await fileDialogService.showOpenDialog({
		title: selecting
			? localize('repoBudSelectConfigurationRepositoryTitle', 'Select Configuration Repository')
			: localize('repoBudInitializeConfigurationRepositoryTitle', 'Initialize Configuration Repository'),
		openLabel: selecting
			? localize('repoBudSelectConfigurationRepositoryLabel', 'Use Repository')
			: localize('repoBudInitializeConfigurationRepositoryLabel', 'Initialize Repository'),
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
	});
	return uris?.[0];
}

async function configureRepository(
	accessor: ServicesAccessor,
	action: 'select' | 'initialize',
	providedUri?: URI,
): Promise<void> {
	const fileDialogService = accessor.get(IFileDialogService);
	const commandService = accessor.get(ICommandService);
	const notificationService = accessor.get(INotificationService);
	const configurationService = accessor.get(ICanonicalConfigurationService);
	const uri = providedUri ?? await pickRepositoryFolder(fileDialogService, action);
	if (!uri) {
		return;
	}
	if (uri.scheme !== 'file') {
		notificationService.error(localize('repoBudConfigurationRepositoryMustBeLocal', 'The configuration repository must be a local folder.'));
		return;
	}

	try {
		let repositoryUri = uri;
		if (action === 'initialize') {
			const repositoryPath = await commandService.executeCommand<string | undefined>(
				'_git.initRepository',
				uri.fsPath
			);
			if (!repositoryPath) {
				return;
			}
			repositoryUri = URI.file(repositoryPath);
		}

		await configurationService.adoptGlobalRepository(repositoryUri);
		notificationService.info(localize(
			'repoBudConfigurationRepositoryReady',
			'Configuration repository ready at {0}. Changes remain uncommitted until you commit them.',
			repositoryUri.fsPath
		));
	} catch (error) {
		notificationService.error(error instanceof Error ? error.message : String(error));
	}
}

async function showConfigurationRepositoryPicker(accessor: ServicesAccessor): Promise<void> {
	const configurationService = accessor.get(ICanonicalConfigurationService);
	const quickInputService = accessor.get(IQuickInputService);
	const items: IConfigurationRepositoryQuickPickItem[] = [];

	if (configurationService.globalRepository) {
		items.push({
			label: localize(
				'repoBudCurrentConfigurationRepository',
				'$(check) Current: {0}',
				basename(configurationService.globalRepository)
			),
			description: configurationService.globalRepository.fsPath,
		});
	}
	items.push({
		label: localize('repoBudChooseConfigurationRepository', '$(folder-opened) Choose Existing Repository...'),
		action: 'select',
		alwaysShow: true,
	}, {
		label: localize('repoBudCreateConfigurationRepository', '$(repo-create) Initialize New Repository...'),
		action: 'initialize',
		alwaysShow: true,
	});

	const picked = await quickInputService.pick(items, {
		title: localize('repoBudConfigurationRepositoryPickerTitle', 'Configuration Repository'),
		placeHolder: localize(
			'repoBudConfigurationRepositoryPickerPlaceholder',
			'Choose the Git repository that owns global Skills and Integrations'
		),
		matchOnDescription: true,
	});
	if (picked?.action) {
		await configureRepository(accessor, picked.action);
	}
}

registerAction2(class ManageConfigurationRepositoryAction extends Action2 {
	constructor() {
		super({
			id: MANAGE_CONFIGURATION_REPOSITORY_COMMAND_ID,
			title: localize2('repoBudManageConfigurationRepository', 'Manage Configuration Repository...'),
			f1: false,
			menu: {
				id: MenuId.ViewContainerTitle,
				group: '1_configuration',
				order: 100,
				when: primaryViewContainerWhen,
			},
		});
	}

	override async run(accessor: ServicesAccessor, args?: IConfigurationRepositoryActionArgs): Promise<void> {
		if (args?.action && args.uri) {
			await configureRepository(accessor, args.action, URI.parse(args.uri));
			return;
		}
		await showConfigurationRepositoryPicker(accessor);
	}
});
