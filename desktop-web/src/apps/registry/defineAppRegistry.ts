import { AppID } from './types';
import type {
    AppDefinition,
    AppRegistryEntry,
    AppRuntimeBinding,
    RegistryValidationResult,
} from './types';

// ─────────────────────────────────────────────────────────────
// Invariant 检查规则（13 条）
// ─────────────────────────────────────────────────────────────

const ALL_APP_IDS = Object.values(AppID) as AppID[];

function collectErrors(
    definitions: ReadonlyArray<AppDefinition>,
    bindings: ReadonlyArray<{ readonly id: AppID; readonly binding: AppRuntimeBinding }>,
): string[] {
    const errors: string[] = [];

    // ── V01 manifest 无重复 AppID ────────────────────────────────────────────
    const manifestIds = new Set<AppID>();
    for (const def of definitions) {
        if (manifestIds.has(def.id)) {
            errors.push(`V01: manifest 中 AppID "${def.id}" 重复声明`);
        }
        manifestIds.add(def.id);
    }

    // ── V02 runtime bindings 无重复 AppID ────────────────────────────────────
    const runtimeIds = new Set<AppID>();
    for (const entry of bindings) {
        if (runtimeIds.has(entry.id)) {
            errors.push(`V02: runtime bindings 中 AppID "${entry.id}" 重复声明`);
        }
        runtimeIds.add(entry.id);
    }

    // ── V03 manifest 覆盖所有 AppID enum 值 ──────────────────────────────────
    for (const id of ALL_APP_IDS) {
        if (!manifestIds.has(id)) {
            errors.push(`V03: AppID "${id}" 缺少 manifest AppDefinition`);
        }
    }

    // ── V04 runtime 覆盖所有 AppID enum 值 ───────────────────────────────────
    for (const id of ALL_APP_IDS) {
        if (!runtimeIds.has(id)) {
            errors.push(`V04: AppID "${id}" 缺少 runtime AppRuntimeBinding`);
        }
    }

    const runtimeMap = new Map<AppID, AppRuntimeBinding>(
        bindings.map(e => [e.id, e.binding]),
    );

    // ── V09 defaultDockSlot：无重复、必须为非负整数 ─────────────────────────
    const dockSlots = new Map<number, AppID>();
    for (const def of definitions) {
        const slot = def.defaultDockSlot;
        if (slot !== undefined) {
            if (!Number.isInteger(slot) || slot < 0) {
                errors.push(`V09a: "${def.id}" defaultDockSlot=${slot} 必须为非负整数`);
            } else if (dockSlots.has(slot)) {
                errors.push(
                    `V09: defaultDockSlot ${slot} 被 "${def.id}" 和 "${dockSlots.get(slot)}" 同时使用`,
                );
            } else {
                dockSlots.set(slot, def.id);
            }
        }
    }

    // ── V15 idlePreloadPriority：无重复、必须为正整数 ────────────────────────
    const preloadPriorities = new Map<number, AppID>();
    for (const entry of bindings) {
        const b = entry.binding;
        if (b.kind === 'standard' || b.kind === 'shared-module') {
            const p = b.idlePreloadPriority;
            if (p !== undefined) {
                if (!Number.isInteger(p) || p < 1) {
                    errors.push(`V15a: "${entry.id}" idlePreloadPriority=${p} 必须为 >= 1 的整数`);
                } else if (preloadPriorities.has(p)) {
                    errors.push(
                        `V15: idlePreloadPriority ${p} 被 "${entry.id}" 和 "${preloadPriorities.get(p)}" 同时使用`,
                    );
                } else {
                    preloadPriorities.set(p, entry.id);
                }
            }
        }
    }

    const defMap = new Map<AppID, AppDefinition>(definitions.map(d => [d.id, d]));

    for (const def of definitions) {
        const { id, exposure, iconKey, displayName } = def;

        // ── V05 desktop/dev-only App 有 iconKey ───────────────────────────────
        if ((exposure === 'desktop' || exposure === 'dev-only') && !iconKey) {
            errors.push(`V05: "${id}" exposure="${exposure}" 必须提供 iconKey`);
        }

        // ── V07 非 shell App 有 displayName ──────────────────────────────────
        if (exposure !== 'shell' && !displayName) {
            errors.push(`V07: "${id}" exposure="${exposure}" 必须提供 displayName`);
        }

        // ── V13 exposure 合法值 ─────────────────────────────────────────────
        const validExposures: AppDefinition['exposure'][] = ['shell', 'desktop', 'hidden', 'dev-only'];
        if (!(validExposures as string[]).includes(exposure)) {
            errors.push(`V13: "${id}" exposure 值非法: "${exposure}"`);
        }

        const binding = runtimeMap.get(id);

        // ── V11 shared-module primaryAppId 存在对应 standard binding ──────────
        if (binding?.kind === 'shared-module') {
            const primary = runtimeMap.get(binding.primaryAppId);
            if (!primary || primary.kind !== 'standard') {
                errors.push(
                    `V11: "${id}" 的 shared-module primaryAppId "${binding.primaryAppId}" ` +
                    `不存在对应的 standard binding`,
                );
            }
        }

        // ── V12 static binding 仅限 shell exposure ───────────────────────────
        if (binding?.kind === 'static' && exposure !== 'shell') {
            errors.push(`V12: "${id}" runtime.kind="static" 但 exposure="${exposure}"，static 仅限 shell`);
        }

        // ── V10 Dock App 必须是 desktop exposure ──────────────────────────────
        if (def.defaultDockSlot !== undefined) {
            const selfDef = defMap.get(id);
            if (selfDef && selfDef.exposure !== 'desktop') {
                errors.push(`V10: "${id}" 在默认 Dock 中，但 exposure="${selfDef.exposure}"（必须是 desktop）`);
            }
        }
    }

    return errors;
}

// ─────────────────────────────────────────────────────────────
// validateAppRegistry — 对外暴露的校验函数
// ─────────────────────────────────────────────────────────────

/**
 * 对 manifest + runtime bindings 执行全部 invariant 检查。
 *
 * 通用函数，内部不写任何 if (id === AppID.Chat) 类业务特化逻辑。
 * 所有特化由调用方在 manifest.ts / runtime.tsx 数据层表达。
 */
export function validateAppRegistry(
    definitions: ReadonlyArray<AppDefinition>,
    bindings: ReadonlyArray<{ readonly id: AppID; readonly binding: AppRuntimeBinding }>,
): RegistryValidationResult {
    const errors = collectErrors(definitions, bindings);
    return {
        valid: errors.length === 0,
        errors,
    };
}

// ─────────────────────────────────────────────────────────────
// buildAppRegistry — 构建已验证的 Registry 查询对象
// ─────────────────────────────────────────────────────────────

export interface AppRegistry {
    /** 按 AppID 查 AppDefinition。 */
    getDefinition(id: AppID): AppDefinition | undefined;
    /** 按 AppID 查 AppRuntimeBinding。 */
    getRuntimeBinding(id: AppID): AppRuntimeBinding | undefined;
    /**
     * 全部条目的只读数组，按 manifest definitions 声明顺序排列。
     * 不使用 ALL_APP_IDS 重排，确保 manifest 顺序是 authority。
     */
    readonly entries: ReadonlyArray<AppRegistryEntry>;
}

/**
 * 构建 App Registry 对象。
 *
 * Fail-fast：若 validation 未通过，DEV 模式立即抛错，停止构建；
 * 生产模式打 console.error 后返回空 registry，不提供 partial 数据。
 */
export function buildAppRegistry(
    definitions: ReadonlyArray<AppDefinition>,
    bindings: ReadonlyArray<{ readonly id: AppID; readonly binding: AppRuntimeBinding }>,
): AppRegistry {
    const result = validateAppRegistry(definitions, bindings);
    if (!result.valid) {
        const msg = `[AppRegistry] validation failed:\n${result.errors.join('\n')}`;
        if (import.meta.env.DEV) {
            throw new Error(msg);
        } else {
            console.error(msg);
            // 生产模式：不返回 partial registry，返回空 registry 防止 consumer 读到脏数据。
            return {
                getDefinition: () => undefined,
                getRuntimeBinding: () => undefined,
                entries: [],
            };
        }
    }

    const defMap = new Map<AppID, AppDefinition>(definitions.map(d => [d.id, d]));
    const bindingMap = new Map<AppID, AppRuntimeBinding>(bindings.map(e => [e.id, e.binding]));

    // entries 保持 manifest definitions 的声明顺序。
    const entries: AppRegistryEntry[] = definitions
        .map(definition => {
            const runtime = bindingMap.get(definition.id);
            return runtime ? { definition, runtime } : null;
        })
        .filter((e): e is AppRegistryEntry => e !== null);

    return {
        getDefinition: (id: AppID) => defMap.get(id),
        getRuntimeBinding: (id: AppID) => bindingMap.get(id),
        entries,
    };
}
