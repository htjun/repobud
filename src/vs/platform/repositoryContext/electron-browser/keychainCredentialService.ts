/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../ipc/electron-browser/services.js';
import { IGitHubCredentialService } from '../common/githubCredentialService.js';
import { IKeychainCredentialService } from '../common/keychainCredentialService.js';

registerMainProcessRemoteService(IKeychainCredentialService, 'keychainCredential');
registerMainProcessRemoteService(IGitHubCredentialService, 'githubCredential');
