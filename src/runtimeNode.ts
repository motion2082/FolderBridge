import { loadBundledOptionalModule } from './optionalNodeModules';

type WindowWithRuntimeRequire = Window & { require?: NodeJS.Require };

/**
 * Resolve the host's CommonJS loader without using eval or generated functions.
 * Desktop Obsidian exposes `require`; mobile does not.
 */
export function getRuntimeRequire(): NodeJS.Require | undefined {
    if (typeof require === 'function') {
        return require;
    }

    if (typeof window !== 'undefined') {
        const windowWithRequire = window as WindowWithRuntimeRequire;
        if (windowWithRequire.require) {
            return windowWithRequire.require;
        }
    }

    return undefined;
}

export function loadOptionalNodeModule<T>(moduleId: string): T | null {
    const bundledModule = loadBundledOptionalModule<T>(moduleId);
    if (bundledModule) {
        return bundledModule;
    }

    const runtimeRequire = getRuntimeRequire();
    if (!runtimeRequire) {
        return null;
    }

    try {
        return runtimeRequire(moduleId) as T;
    } catch {
        return null;
    }
}
