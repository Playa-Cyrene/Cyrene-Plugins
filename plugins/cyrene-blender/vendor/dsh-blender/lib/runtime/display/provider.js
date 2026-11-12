import { displayCapabilities } from './prerequisites.js';
import { LinuxXvfbVirtualGlProvider } from './linux-xvfb-virtualgl.js';
import { WinHiddenDesktopProvider } from './win-hidden-desktop.js';
/** Ordered fallback list; the first implemented candidate wins. */
export function providerCandidates(platform = process.platform) {
    if (platform === 'win32') {
        return [
            { kind: 'win-hidden-desktop', preview: false, implemented: true },
            { kind: 'win-idd', preview: false, implemented: false },
        ];
    }
    if (platform === 'linux') {
        return [{ kind: 'linux-xvfb-virtualgl', preview: true, implemented: true }];
    }
    return [{ kind: 'macos-provider', preview: false, implemented: false }];
}
export function selectDisplayProvider(options = {}) {
    const platform = options.platform || process.platform;
    const capabilities = options.capabilities || displayCapabilities();
    const candidates = providerCandidates(platform);
    const chosen = candidates.find((candidate) => candidate.implemented);
    if (!capabilities.ready) {
        return {
            provider: null,
            candidates,
            capabilities,
            reason: capabilities.reason || 'provider_unavailable',
        };
    }
    if (chosen && chosen.kind === 'win-hidden-desktop') {
        return {
            provider: new WinHiddenDesktopProvider({
                env: options.env,
                helperPath: options.helperPath,
            }),
            candidates,
            capabilities,
            reason: null,
        };
    }
    if (chosen && chosen.kind === 'linux-xvfb-virtualgl') {
        return {
            provider: new LinuxXvfbVirtualGlProvider({ env: options.env }),
            candidates,
            capabilities,
            reason: null,
        };
    }
    return { provider: null, candidates, capabilities, reason: 'provider_unavailable' };
}
//# sourceMappingURL=provider.js.map