import type express from "express"
import { getKey } from "../../utils/keys"
import { ContentProvider } from "../base/ContentProvider"
import { ONSTAGE_API_URL, onStageConnect, onStageDisconnect, onStageInitialize, onStageStartupLoad, type OnStageAuthData, type OnStageScopes } from "./connect"
import { onStageLoadServices } from "./request"

// Re-export types from connect file
export type { OnStageScopes } from "./connect"

// Fix OnStageAuthData to not include null in the export
export interface OnStageAuthDataResolved {
    access_token: string
    refresh_token: string
    token_type: "Bearer"
    created_at: number
    expires_in: number
    scope: OnStageScopes
}

/**
 * OnStage provider that acts as the sole interface to OnStage functionality.
 *
 * This is the ONLY class that should import from connect.ts and request.ts.
 * All external code should use this provider through ContentProviderRegistry.
 */
export class OnStageProvider extends ContentProvider<OnStageScopes, OnStageAuthDataResolved> {
    constructor() {
        super({
            providerId: "onstage",
            displayName: "OnStage",
            port: 5503,
            clientId: getKey("onstage_id") || "",
            clientSecret: "", // public client — PKCE only, no secret exists
            apiUrl: ONSTAGE_API_URL,
            scopes: ["presenter"] as const
        })
    }

    isConnected(scope: OnStageScopes): boolean {
        return this.access !== null && this.access.scope === scope
    }

    async connect(scope: OnStageScopes): Promise<OnStageAuthDataResolved | null> {
        const result = await onStageConnect(scope)
        this.access = result
        return result
    }

    disconnect(scope: OnStageScopes = "presenter"): void {
        onStageDisconnect(scope)
        this.access = null
    }

    async apiRequest(_data: any): Promise<any> {
        // Not used — request.ts owns the presenter API calls.
        return null
    }

    async loadServices(): Promise<void> {
        return onStageLoadServices()
    }

    async startupLoad(scope: OnStageScopes): Promise<void> {
        onStageInitialize()
        return onStageStartupLoad(scope)
    }

    protected handleAuthCallback(_req: express.Request, _res: express.Response): void {
        // Not used - connect.ts handles authentication internally
    }

    protected async refreshToken(_scope: OnStageScopes): Promise<OnStageAuthDataResolved | null> {
        // Not used - connect.ts handles token refresh internally
        return null
    }

    protected async authenticate(_scope: OnStageScopes): Promise<OnStageAuthDataResolved | null> {
        // Not used - connect.ts handles authentication internally
        return null
    }
}

export type { OnStageAuthData }
