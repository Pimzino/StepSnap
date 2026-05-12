import { create } from "zustand";

export type StartupPhase = "booting" | "shell-ready" | "background-startup";
export type StartupTaskKey =
    | "settings"
    | "database"
    | "services"
    | "ocr"
    | "hotkeys"
    | "updates"
    | "notifications"
    | "complete";
export type StartupTaskState = "pending" | "running" | "success" | "failed";

export interface StartupStatusPayload {
    phase?: StartupPhase;
    task: StartupTaskKey;
    state: StartupTaskState;
    message: string;
    done?: number | null;
    total?: number | null;
}

export interface StartupTaskStatus {
    task: StartupTaskKey;
    state: StartupTaskState;
    message: string;
    done: number | null;
    total: number | null;
}

interface StartupStoreState {
    phase: StartupPhase;
    statusMessage: string;
    detailMessage: string | null;
    tasks: Record<StartupTaskKey, StartupTaskStatus>;
    isShellReady: boolean;
    isStartupComplete: boolean;
    ignoreBackendOcr: boolean;
    applyStatus: (status: StartupStatusPayload, source?: "frontend" | "backend") => void;
    markShellReady: () => void;
    markOcrDisabled: () => void;
}

const MONITOR_PICKER_HASH = "#/monitor-picker";
const SPLASH_FADE_MS = 220;
const BACKEND_TASK_ORDER: StartupTaskKey[] = ["database", "services", "hotkeys", "ocr"];
const COMPLETION_TASKS: StartupTaskKey[] = [
    "settings",
    "database",
    "services",
    "ocr",
    "hotkeys",
    "updates",
    "notifications",
];

function createTask(task: StartupTaskKey, message = ""): StartupTaskStatus {
    return {
        task,
        state: "pending",
        message,
        done: null,
        total: null,
    };
}

function createInitialTasks(): Record<StartupTaskKey, StartupTaskStatus> {
    return {
        settings: createTask("settings", "Loading settings"),
        database: createTask("database", "Preparing local data"),
        services: createTask("services", "Starting services"),
        ocr: createTask("ocr", "Queueing OCR warmup"),
        hotkeys: createTask("hotkeys", "Registering hotkeys"),
        updates: createTask("updates", "Checking for updates"),
        notifications: createTask("notifications", "Loading notifications"),
        complete: createTask("complete", "Startup complete"),
    };
}

function isMonitorPickerWindow(): boolean {
    return window.location.hash === MONITOR_PICKER_HASH || window.location.hash.startsWith(`${MONITOR_PICKER_HASH}/`);
}

function getSplashElements() {
    return {
        splash: document.getElementById("splash"),
        status: document.getElementById("splash-status"),
        detail: document.getElementById("splash-detail"),
    };
}

function syncSplashDom(message: string, detail: string | null) {
    if (isMonitorPickerWindow()) {
        return;
    }

    const { status, detail: detailNode } = getSplashElements();
    if (status) {
        status.textContent = message;
    }
    if (detailNode) {
        detailNode.textContent = detail ?? "";
        detailNode.classList.toggle("hidden", !detail);
    }
}

function hideSplashDom() {
    const { splash } = getSplashElements();
    if (!splash || splash.classList.contains("hidden")) {
        return;
    }

    splash.classList.add("is-hiding");
    window.setTimeout(() => {
        splash.classList.add("hidden");
    }, SPLASH_FADE_MS);
}

function isTerminalState(state: StartupTaskState) {
    return state === "success" || state === "failed";
}

function computeDetailMessage(task: StartupTaskStatus): string | null {
    if (typeof task.done === "number" && typeof task.total === "number") {
        return `${task.done}/${task.total}`;
    }
    return null;
}

function markEarlierBackendTasksReady(
    tasks: Record<StartupTaskKey, StartupTaskStatus>,
    currentTask: StartupTaskKey,
) {
    const currentIndex = BACKEND_TASK_ORDER.indexOf(currentTask);
    if (currentIndex <= 0) {
        return tasks;
    }

    const nextTasks = { ...tasks };
    for (let index = 0; index < currentIndex; index += 1) {
        const taskKey = BACKEND_TASK_ORDER[index];
        if (!isTerminalState(nextTasks[taskKey].state)) {
            nextTasks[taskKey] = {
                ...nextTasks[taskKey],
                state: "success",
            };
        }
    }
    return nextTasks;
}

function finalizeTasks(tasks: Record<StartupTaskKey, StartupTaskStatus>) {
    const startupComplete = COMPLETION_TASKS.every((taskKey) => isTerminalState(tasks[taskKey].state));
    const completeTask: StartupTaskStatus = {
        ...tasks.complete,
        state: startupComplete ? "success" : "pending",
        message: startupComplete ? "Startup complete" : tasks.complete.message,
    };

    return {
        tasks: {
            ...tasks,
            complete: completeTask,
        },
        startupComplete,
    };
}

export const useStartupStore = create<StartupStoreState>((set, get) => ({
    phase: "booting",
    statusMessage: "Starting StepSnap",
    detailMessage: null,
    tasks: createInitialTasks(),
    isShellReady: false,
    isStartupComplete: false,
    ignoreBackendOcr: false,

    applyStatus: (status, source = "frontend") => {
        set((state) => {
            if (source === "backend" && status.task === "ocr" && state.ignoreBackendOcr) {
                return state;
            }

            let nextTasks = { ...state.tasks };
            if (source === "backend") {
                nextTasks = markEarlierBackendTasksReady(nextTasks, status.task);
            }

            const previous = nextTasks[status.task];
            const nextTask: StartupTaskStatus = {
                ...previous,
                state: status.state,
                message: status.message,
                done: status.done ?? previous.done,
                total: status.total ?? previous.total,
            };
            nextTasks[status.task] = nextTask;

            const { tasks, startupComplete } = finalizeTasks(nextTasks);
            const nextPhase = state.isShellReady
                ? (status.phase ?? "background-startup")
                : "booting";

            return {
                phase: nextPhase,
                statusMessage: status.message,
                detailMessage: computeDetailMessage(nextTask),
                tasks,
                isStartupComplete: startupComplete,
            };
        });

        const snapshot = get();
        syncSplashDom(snapshot.statusMessage, snapshot.detailMessage);
    },

    markShellReady: () => {
        set((state) => ({
            phase: "shell-ready",
            isShellReady: true,
            statusMessage: state.statusMessage,
        }));

        const snapshot = get();
        syncSplashDom(snapshot.statusMessage, snapshot.detailMessage);
        hideSplashDom();
    },

    markOcrDisabled: () => {
        set((state) => {
            const nextTasks: Record<StartupTaskKey, StartupTaskStatus> = {
                ...state.tasks,
                ocr: {
                    ...state.tasks.ocr,
                    state: "success",
                    message: "OCR disabled in settings",
                    done: null,
                    total: null,
                },
            };

            const { tasks, startupComplete } = finalizeTasks(nextTasks);
            return {
                statusMessage: "OCR disabled in settings",
                detailMessage: null,
                tasks,
                isStartupComplete: startupComplete,
                ignoreBackendOcr: true,
            };
        });

        const snapshot = get();
        syncSplashDom(snapshot.statusMessage, snapshot.detailMessage);
    },
}));
