// App subsystem 的唯一注册中心。
// App metadata / default Dock / runtime binding 均从这里派生。
// 不在此处维护第二份 App inventory。

export { AppID } from './types';

export type {
    AppExposure,
    AppDefinition,
    DesktopAppDefinition,
    StandardRuntimeBinding,
    SharedModuleRuntimeBinding,
    StaticRuntimeBinding,
    AppRuntimeBinding,
    AppRegistryEntry,
    RegistryValidationResult,
} from './types';

export {
    getAppDisplayName,
    getDefaultDockApps,
    getDefaultDockAppIds,
    getInstalledAppDefinitions,
    getDesktopAppDefinition,
} from './selectors';

export { APP_MANIFEST } from './manifest';
export { APP_RUNTIME_BINDINGS } from './runtime';

import { validateAppRegistry, buildAppRegistry } from './defineAppRegistry';
export { validateAppRegistry, buildAppRegistry };
export type { AppRegistry } from './defineAppRegistry';

import { APP_MANIFEST } from './manifest';
import { APP_RUNTIME_BINDINGS } from './runtime';

/**
 * 已验证的全局 App Registry 单例。
 * 模块加载时执行一次 validation；DEV 模式下若 invariant 不通过则抛错。
 */
export const APP_REGISTRY = buildAppRegistry(APP_MANIFEST, APP_RUNTIME_BINDINGS);
