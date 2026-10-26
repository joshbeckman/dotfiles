// Every package's handlers, merged. Each work package edits only its own handlers.ts.

import type { Handlers } from "../api/types.ts";
import { handlers as memory } from "../memory/handlers.ts";
import { handlers as push } from "../push/handlers.ts";
import { handlers as schedules } from "../schedules/handlers.ts";
import { handlers as search } from "../search/handlers.ts";
import { handlers as sessions } from "../sessions/handlers.ts";
import { handlers as threads } from "../threads/handlers.ts";
import { handlers as web } from "../web/handlers.ts";

export const defaultHandlers: Handlers = {
	...threads,
	...sessions,
	...memory,
	...schedules,
	...search,
	...push,
	...web,
};
