import { AsyncLocalStorage } from "node:async_hooks";

interface NoticeDispatch {
	owner: object;
	open: boolean;
}

// One scope per awaited dispatch, not a session-wide busy flag. Inherited callbacks
// must also check open: a detached timer may outlive the dispatch that created it.
const dispatch = new AsyncLocalStorage<NoticeDispatch>();

export async function withCompactionNoticeScope<T>(owner: object, emit: () => Promise<T>): Promise<T> {
	const scope: NoticeDispatch = { owner, open: true };
	return dispatch.run(scope, async () => {
		try {
			return await emit();
		} finally {
			scope.open = false;
		}
	});
}

export function isCompactionNoticeSource(owner: object): boolean {
	const scope = dispatch.getStore();
	return scope?.open === true && scope.owner === owner;
}

/** Host observers are not extension-handler ingress, including callbacks they schedule. */
export function outsideCompactionNoticeScope<T>(callback: () => T): T {
	return dispatch.exit(callback);
}
