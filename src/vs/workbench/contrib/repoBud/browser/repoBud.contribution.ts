/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../common/editor.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IFilesConfigurationService } from '../../../services/filesConfiguration/common/filesConfigurationService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { REPOBUD_VIEW_CONTAINER_IDS, REPOBUD_VIEW_IDS, isRepoBudViewContainerAllowed } from '../common/repoBud.js';
import { IRepositoryCatalogService } from '../common/repositoryCatalog.js';
import './canonicalConfigurationActions.js';
import './canonicalConfigurationService.js';
import './contextConnectionService.js';
import './contextMcpIntegrationService.js';
import './contextPluginService.js';
import './contextSkillService.js';
import './pluginActions.js';
import './repositoryCatalogActions.js';
import './repositoryCatalogService.js';
import './skillActions.js';
import { RepoBudViewPane } from './repoBudView.js';
import { IntegrationsViewPane } from './integrationsView.js';
import { SkillsViewPane } from './skillsView.js';

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
configurationRegistry.registerDefaultConfigurations([{
	overrides: {
		'window.commandCenter': false,
		'window.menuBarVisibility': 'hidden',
		'window.title': '${rootNameShort}',
		'chat.titleBar.openInAgentsWindow.enabled': false,
		'files.readonlyInclude': { '**': true },
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
	source: 'repoBudDefaults',
}]);

const viewContainersRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

viewContainersRegistry.setViewContainerUserReachabilityProvider((viewContainer, location) =>
	isRepoBudViewContainerAllowed(viewContainer.id, location)
);

function registerProductArea(
	id: string,
	viewId: string,
	title: ReturnType<typeof localize2>,
	icon: ReturnType<typeof registerIcon>,
	order: number,
	welcomeContent: string,
	ctorDescriptor: SyncDescriptor<ViewPane> = new SyncDescriptor(RepoBudViewPane),
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
		ctorDescriptor,
	}], viewContainer);

	viewsRegistry.registerViewWelcomeContent(viewId, {
		content: welcomeContent,
		when: 'default',
	});
}

const skillsViewIcon = registerIcon(
	'repobud-skills-view-icon',
	Codicon.library,
	localize('repoBudSkillsViewIcon', 'View icon of the Skills view.')
);
const integrationsViewIcon = registerIcon(
	'repobud-integrations-view-icon',
	Codicon.plug,
	localize('repoBudIntegrationsViewIcon', 'View icon of the Integrations view.')
);

registerProductArea(
	REPOBUD_VIEW_CONTAINER_IDS.skills,
	REPOBUD_VIEW_IDS.skills,
	localize2('repoBudSkills', 'Skills'),
	skillsViewIcon,
	3,
	localize('repoBudSkillsWelcome', 'Skills available to the active repository will appear here.'),
	new SyncDescriptor(SkillsViewPane)
);
registerProductArea(
	REPOBUD_VIEW_CONTAINER_IDS.integrations,
	REPOBUD_VIEW_IDS.integrations,
	localize2('repoBudIntegrations', 'Integrations'),
	integrationsViewIcon,
	4,
	localize('repoBudIntegrationsWelcome', 'MCP servers, connections, and plugins for the active repository will appear here.'),
	new SyncDescriptor(IntegrationsViewPane)
);

class RepoBudStartupContribution extends Disposable {

	static readonly ID = 'workbench.contrib.repoBud.startup';

	constructor(
		@IViewsService viewsService: IViewsService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@IHostService hostService: IHostService,
		@IEditorService editorService: IEditorService,
		@IFilesConfigurationService filesConfigurationService: IFilesConfigurationService,
		@IRepositoryCatalogService _repositoryCatalogService: IRepositoryCatalogService,
	) {
		super();

		const folders = workspaceContextService.getWorkspace().folders;
		if (folders.length > 1) {
			void hostService.openWindow([{ folderUri: folders[0].uri }], { forceReuseWindow: true });
			return;
		}

		layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
		layoutService.setPartHidden(true, Parts.PANEL_PART);
		layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
		void viewsService.openViewContainer(REPOBUD_VIEW_CONTAINER_IDS.sourceControl);

		const enforceActiveEditorReadonly = () => {
			const resource = EditorResourceAccessor.getOriginalUri(editorService.activeEditor, {
				supportSideBySide: SideBySideEditor.BOTH,
			});
			if (URI.isUri(resource)) {
				void filesConfigurationService.updateReadonly(resource, true);
			} else if (resource) {
				const resources = [resource.primary, resource.secondary].filter(URI.isUri);
				void filesConfigurationService.updateReadonly(resources, true);
			}
		};

		this._register(editorService.onDidActiveEditorChange(enforceActiveEditorReadonly));
		enforceActiveEditorReadonly();
	}
}

registerWorkbenchContribution2(
	RepoBudStartupContribution.ID,
	RepoBudStartupContribution,
	WorkbenchPhase.AfterRestored
);
