// Pure board domain — no Cordis/Context dependency, so the smoke test can
// exercise the CRUD + status-flow logic directly without a running harness.
// v2: multi-board, workspace-scoped, extended task model.
//
// The plugin wraps this in a Cordis Service (service key), so the shared state
// is materialized as a coefficient (ctx.teamBoard), never a module-level global.

/** Default status flow (a board may override at creation). */
export const DEFAULT_STATUSES = ['todo', 'doing', 'in-review', 'blocked', 'done'];

/** Priorities, low → high. */
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

/** Workspace key used when a session carries no cwd. */
export const NO_WORKSPACE = '_no-cwd';

/** Whether a patch value should be dropped (undefined → keep the old field). */
function isOmitted(value) {
    return value === undefined || value === null;
}

/** Filter an object to defined entries only. */
function clean(patch) {
    return Object.fromEntries(Object.entries(patch).filter(([, v]) => !isOmitted(v)));
}

/**
 * In-memory multi-board task store. All state lives here (per workspace
 * instance); mutation methods return the affected entity so callers can
 * persist snapshots. Task ids are globally unique; board ids are unique
 * within the store.
 */
export class BoardStore {
    /** boardId → Board */
    boards = new Map();
    /** taskId → Task */
    tasks = new Map();
    counter = 0;

    constructor(seed) {
        for (const board of seed?.boards ?? [])
            this.boards.set(board.id, board);
        for (const task of seed?.tasks ?? [])
            this.tasks.set(task.id, task);
    }

    //#region boards

    /** Create a board in `workspace` (the caller's cwd key). */
    createBoard(input) {
        const now = Date.now();
        const board = {
            id: this.mintId('board'),
            name: input.name,
            workspace: input.workspace ?? NO_WORKSPACE,
            statuses: Array.isArray(input.statuses) && input.statuses.length > 0
                ? input.statuses
                : [...DEFAULT_STATUSES],
            archived: false,
            createdAt: now,
            updatedAt: now,
        };
        this.boards.set(board.id, board);
        return board;
    }

    /** All boards in `workspace`, optionally including archived ones. */
    listBoards(workspace, opts = {}) {
        const out = [...this.boards.values()]
            .filter((b) => b.workspace === (workspace ?? NO_WORKSPACE))
            .filter((b) => (opts.includeArchived ? true : !b.archived));
        return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    }

    renameBoard(id, name) {
        const board = this.requireBoard(id);
        return this.putBoard({ ...board, name });
    }

    /** Add a status column to a board's flow. */
    addStatus(id, status) {
        const board = this.requireBoard(id);
        const trimmed = String(status).trim();
        if (trimmed === '') throw new Error('status name cannot be empty');
        if (board.statuses.includes(trimmed)) throw new Error(`status "${trimmed}" already exists on board "${board.name}"`);
        return this.putBoard({ ...board, statuses: [...board.statuses, trimmed] });
    }

    /** Rename a status column, migrating any tasks sitting in it. */
    renameStatus(id, oldStatus, newStatus) {
        const board = this.requireBoard(id);
        const trimmed = String(newStatus).trim();
        if (trimmed === '') throw new Error('status name cannot be empty');
        if (trimmed !== oldStatus && board.statuses.includes(trimmed)) {
            throw new Error(`status "${trimmed}" already exists on board "${board.name}"`);
        }
        const next = this.putBoard({
            ...board,
            statuses: board.statuses.map((s) => (s === oldStatus ? trimmed : s)),
        });
        // Migrate tasks sitting in the renamed column.
        for (const task of this.tasks.values()) {
            if (task.boardId === board.id && task.status === oldStatus) {
                this.tasks.set(task.id, { ...task, status: trimmed, updatedAt: Date.now() });
            }
        }
        return next;
    }

    /** Remove a status column (tasks in it fall back to the first status). */
    removeStatus(id, status) {
        const board = this.requireBoard(id);
        if (board.statuses.length <= 1) throw new Error('cannot remove the last status column');
        if (!board.statuses.includes(status)) throw new Error(`status "${status}" not found on board "${board.name}"`);
        const fallback = board.statuses.find((s) => s !== status) ?? 'todo';
        const next = this.putBoard({
            ...board,
            statuses: board.statuses.filter((s) => s !== status),
        });
        for (const task of this.tasks.values()) {
            if (task.boardId === board.id && task.status === status) {
                this.tasks.set(task.id, { ...task, status: fallback, updatedAt: Date.now() });
            }
        }
        return next;
    }

    /** Archive a board (and its tasks stay archived-in-place). */
    archiveBoard(id) {
        const board = this.requireBoard(id);
        return this.putBoard({ ...board, archived: true });
    }

    /** Restore an archived board. */
    restoreBoard(id) {
        const board = this.requireBoard(id);
        return this.putBoard({ ...board, archived: false });
    }

    //#endregion

    //#region tasks

    /** Create a task on `boardId`. Extra fields (priority/tags/dueDate/description/...) are accepted and stored. */
    createTask(input) {
        const board = this.requireBoard(input.boardId);
        const now = Date.now();
        const task = {
            id: this.mintId('task'),
            boardId: board.id,
            subject: input.subject,
            status: input.status ?? 'todo',
            priority: input.priority ?? 'medium',
            tags: input.tags ?? [],
            description: input.description ?? '',
            deps: input.deps ?? [],
            comments: [],
            archived: false,
            checked: false,
            createdAt: now,
            updatedAt: now,
            ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
            ...(input.owner === undefined ? {} : { owner: input.owner }),
        };
        if (!board.statuses.includes(task.status)) {
            throw new Error(`status "${task.status}" is not in board "${board.name}" statuses [${board.statuses.join(', ')}]`);
        }
        this.tasks.set(task.id, task);
        return task;
    }

    /** Claim a task: mark it `doing` and assign the owner. */
    claim(id, owner) {
        const task = this.require(id);
        return this.put({ ...task, status: 'doing', owner });
    }

    /** Partial update — omitted fields are preserved. */
    update(id, patch) {
        const task = this.require(id);
        const next = this.put({ ...task, ...clean(patch) });
        const board = this.boards.get(next.boardId);
        if (board && !board.statuses.includes(next.status)) {
            throw new Error(`status "${next.status}" is not in board "${board.name}" statuses [${board.statuses.join(', ')}]`);
        }
        return next;
    }

    /** Move a task to a different status (validated against its board). */
    transition(id, status) {
        const task = this.require(id);
        const board = this.boards.get(task.boardId);
        if (board && !board.statuses.includes(status)) {
            throw new Error(`status "${status}" is not in board "${board.name}" statuses [${board.statuses.join(', ')}]`);
        }
        return this.put({ ...task, status });
    }

    /** Add a comment to a task. */
    addComment(taskId, comment) {
        const task = this.require(taskId);
        const entry = {
            id: this.mintId('cmt'),
            author: comment.author ?? 'unknown',
            text: comment.text,
            at: comment.at ?? Date.now(),
        };
        const next = this.put({ ...task, comments: [...task.comments, entry] });
        return { task: next, comment: entry };
    }

    /** Archive a task (kept in the store, hidden from default lists). */
    archive(id) {
        const task = this.require(id);
        return this.put({ ...task, archived: true });
    }

    /** Restore an archived task. */
    restore(id) {
        const task = this.require(id);
        return this.put({ ...task, archived: false });
    }

    /**
     * List tasks with filters:
     *   boardId / status / owner / priority / tag / archived / includeArchived
     * Sorted by createdAt then id.
     */
    list(filter = {}) {
        let out = [...this.tasks.values()];
        if (filter.boardId !== undefined)
            out = out.filter((t) => t.boardId === filter.boardId);
        if (filter.status !== undefined)
            out = out.filter((t) => t.status === filter.status);
        if (filter.owner !== undefined)
            out = out.filter((t) => t.owner === filter.owner);
        if (filter.priority !== undefined)
            out = out.filter((t) => t.priority === filter.priority);
        if (filter.tag !== undefined)
            out = out.filter((t) => t.tags.includes(filter.tag));
        if (filter.includeArchived) {
            // no archived filtering — caller asked for everything
        } else if (filter.archived === true) {
            out = out.filter((t) => t.archived);
        } else {
            out = out.filter((t) => !t.archived);
        }
        return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    }

    get(id) {
        return this.tasks.get(id);
    }

    remove(id) {
        return this.tasks.delete(id);
    }

    //#endregion

    //#region snapshot / restore

    /** Full serializable state — the whole board set + tasks. */
    snapshot() {
        return {
            boards: [...this.boards.values()],
            tasks: [...this.tasks.values()],
        };
    }

    //#endregion

    //#region internals

    putBoard(board) {
        const next = { ...board, updatedAt: Date.now() };
        this.boards.set(next.id, next);
        return next;
    }

    put(task) {
        const next = { ...task, updatedAt: Date.now() };
        this.tasks.set(next.id, next);
        return next;
    }

    require(id) {
        const task = this.tasks.get(id);
        if (!task)
            throw new Error(`task "${id}" not found`);
        return task;
    }

    requireBoard(id) {
        const board = this.boards.get(id);
        if (!board)
            throw new Error(`board "${id}" not found`);
        return board;
    }

    mintId(kind) {
        let id;
        do {
            this.counter += 1;
            id = `${kind}-${Date.now().toString(36)}-${this.counter.toString(36)}`;
        } while (this.tasks.has(id) || this.boards.has(id));
        return id;
    }

    //#endregion
}

