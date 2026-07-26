/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { REPOSITORY_CONTEXT_VIEW_CONTAINER_IDS, REPOSITORY_CONTEXT_VIEW_IDS, isRepositoryContextViewContainerAllowed } from '../common/repositoryContext.js';
import { RepositoryContextViewPane } from './repositoryContextView.js';

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
configurationRegistry.registerDefaultConfigurations([{
	overrides: {
		'window.commandCenter': false,
		'window.menuBarVisibility': 'hidden',
		'chat.titleBar.openInAgentsWindow.enabled': false,
		'onboarding.enabled': false,
		'security.workspace.trust.enabled': false,
		'workbench.activityBar.location': 'top',
		'workbench.editor.empty.hint': 'hidden',
		'workbench.editor.showTabs': 'single',
		'workbench.layoutControl.enabled': false,
		'workbench.navigationControl.enabled': false,
		'workbench.secondarySideBar.defaultVisibility': 'hidden',
		'workbench.startupEditor': 'none',
		'workbench.statusBar.visible': false,
		'workbench.tips.enabled': false,
	},
	donotCache: true,
	preventExperimentOverride: true,
	source: 'repositoryContextWorkbenchDefaults',
}]);

const viewContainersRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

viewContainersRegistry.setViewContainerUserReachabilityProvider((viewContainer, location) =>
	isRepositoryContextViewContainerAllowed(viewContainer.id, location)
);

function registerProductArea(
	id: string,
	viewId: string,
	title: ReturnType<typeof localize2>,
	icon: ReturnType<typeof registerIcon>,
	order: number,
	welcomeContent: string,
): void {
	const viewContainer = viewContainersRegistry.registerViewContainer({
		id,
		title,
		icon,
		order,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [id, { mergeViewWithContainerWhenSingleView: true }]),
		storageId: id,
		alwaysUseContainerInfo: true,
	}, ViewContainerLocation.Sidebar);

	viewsRegistry.registerViews([{
		id: viewId,
		name: title,
		containerIcon: icon,
		canMoveView: false,
		canToggleVisibility: false,
		ctorDescriptor: new SyncDescriptor(RepositoryContextViewPane),
	}], viewContainer);

	viewsRegistry.registerViewWelcomeContent(viewId, {
		content: welcomeContent,
		when: 'default',
	});
}

const skillsViewIcon = registerIcon(
	'repository-context-skills-view-icon',
	Codicon.library,
	localize('repositoryContextSkillsViewIcon', 'View icon of the Skills view.')
);
const integrationsViewIcon = registerIcon(
	'repository-context-integrations-view-icon',
	Codicon.plug,
	localize('repositoryContextIntegrationsViewIcon', 'View icon of the Integrations view.')
);

registerProductArea(
	REPOSITORY_CONTEXT_VIEW_CONTAINER_IDS.skills,
	REPOSITORY_CONTEXT_VIEW_IDS.skills,
	localize2('repositoryContextSkills', 'Skills'),
	skillsViewIcon,
	3,
	localize('repositoryContextSkillsWelcome', 'Skills available to the active repository will appear here.')
);
registerProductArea(
	REPOSITORY_CONTEXT_VIEW_CONTAINER_IDS.integrations,
	REPOSITORY_CONTEXT_VIEW_IDS.integrations,
	localize2('repositoryContextIntegrations', 'Integrations'),
	integrationsViewIcon,
	4,
	localize('repositoryContextIntegrationsWelcome', 'MCP servers, connections, and plugins for the active repository will appear here.')
);

class RepositoryContextStartupContribution {

	static readonly ID = 'workbench.contrib.repositoryContext.startup';

	constructor(
		@IViewsService viewsService: IViewsService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
	) {
		layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
		layoutService.setPartHidden(true, Parts.PANEL_PART);
		layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
		void viewsService.openViewContainer(REPOSITORY_CONTEXT_VIEW_CONTAINER_IDS.sourceControl);
	}
}

registerWorkbenchContribution2(
	RepositoryContextStartupContribution.ID,
	RepositoryContextStartupContribution,
	WorkbenchPhase.AfterRestored
);
