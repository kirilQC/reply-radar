import "attio"

import type appSettingsSchema from "../src/app/settings/schema"

declare module "attio" {
    export interface AppSettingsSchema {
        workspace: (typeof appSettingsSchema)["fields"]
    }
}
