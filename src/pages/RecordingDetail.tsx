import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
    AlertTriangle,
    ArrowLeft,
    Check,
    Pencil,
    Play,
    Save,
    Square,
    Wand2,
    X,
    XCircle,
} from "lucide-react";

import ExportDropdown from "../components/ExportDropdown";
import MarkdownViewer from "../components/MarkdownViewer";
import Sidebar from "../components/Sidebar";
import Spinner from "../components/Spinner";
import Tooltip from "../components/Tooltip";
import type { StreamingCallbacks } from "../lib/aiService";
import { mapStepsForAI } from "../lib/stepMapper";
import { useRecorderStore } from "../store/recorderStore";
import { useGenerationStore } from "../store/generationStore";
import { useRecordingsStore, Step as DBStep } from "../store/recordingsStore";
import { useSettingsStore } from "../store/settingsStore";
import { useToastStore } from "../store/toastStore";
import { log, describeError } from "../lib/logger";

const StepsTab = lazy(() => import("./recording-detail/StepsTab"));
const DocumentationEditor = lazy(() => import("./recording-detail/DocumentationEditor"));
const LazyImageEditor = lazy(() => import("../components/ImageEditor"));
const LazyGenerationSplitView = lazy(() => import("../components/generation/GenerationSplitView"));

function DeferredPanelFallback({ label }: { label: string }) {
    return (
        <div className="flex min-h-[320px] items-center justify-center text-white/50">
            <div className="flex flex-col items-center gap-3">
                <Spinner />
                <p>{label}</p>
            </div>
        </div>
    );
}

function DeferredModalFallback({ label }: { label: string }) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
            <div className="glass-surface-1 flex items-center gap-3 rounded-xl px-5 py-4 text-white/80">
                <Spinner size="sm" />
                <span>{label}</span>
            </div>
        </div>
    );
}

export default function RecordingDetail() {
    const navigate = useNavigate();
    const { id } = useParams<{ id: string }>();
    const location = useLocation();
    const { currentRecording, getRecording, saveDocumentation, updateRecordingName, loading } = useRecordingsStore();
    const { isRecording, setIsRecording } = useRecorderStore();
    const { openaiApiKey, openaiBaseUrl, openaiModel, screenshotPath } = useSettingsStore();
    const {
        isGenerating,
        startGeneration,
        updateStepStatus,
        appendStreamingText,
        completeStep,
        setStepError,
        updateDocument,
        startPolishing,
        finishPolishing,
        finishGeneration,
        cancelGeneration,
        resetGeneration,
    } = useGenerationStore();

    const [activeTab, setActiveTab] = useState<"steps" | "docs">("docs");
    const [showRegenerationModal, setShowRegenerationModal] = useState(false);
    const [stepsForRegeneration, setStepsForRegeneration] = useState<ReturnType<typeof mapStepsForAI>>([]);
    const [isEditing, setIsEditing] = useState(false);
    const [editedContent, setEditedContent] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [croppingStep, setCroppingStep] = useState<{ stepId: string; target: "before" | "after" } | null>(null);
    const [cropTimestamps, setCropTimestamps] = useState<Record<string, number>>({});

    const [localSteps, setLocalSteps] = useState<DBStep[]>([]);
    const [deletedStepIds, setDeletedStepIds] = useState<Set<string>>(new Set());
    const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
    const [insertPosition, setInsertPosition] = useState<number | null>(null);
    const [isSelectingPosition, setIsSelectingPosition] = useState(false);
    const [saving, setSaving] = useState(false);
    const [deletingStepId, setDeletingStepId] = useState<string | null>(null);
    const [isEditingName, setIsEditingName] = useState(false);
    const [editedName, setEditedName] = useState("");
    const [nameSaving, setNameSaving] = useState(false);
    const hasTriggeredGeneration = useRef(false);
    const descriptionSaveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
    const titleSaveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
    // During recording, `new-step` events arrive with the recorder's UUID,
    // but we store local steps under fresh `temp-...` IDs. This map lets the
    // `new-step-after` listener find the corresponding local step to update.
    const recorderIdToTempId = useRef<Map<string, string>>(new Map());

    useEffect(() => {
        if (id) {
            void getRecording(id);
        }
    }, [id, getRecording]);

    useEffect(() => {
        const descTimers = descriptionSaveTimers.current;
        const titleTimers = titleSaveTimers.current;
        return () => {
            descTimers.forEach(clearTimeout);
            descTimers.clear();
            titleTimers.forEach(clearTimeout);
            titleTimers.clear();
        };
    }, [id]);

    useEffect(() => {
        if (currentRecording?.steps) {
            setLocalSteps(currentRecording.steps);
            setDeletedStepIds(new Set());
            setHasUnsavedChanges(false);
            setInsertPosition(null);
        }
    }, [currentRecording?.recording.id]);

    useEffect(() => {
        if (
            location.state?.triggerGeneration &&
            currentRecording &&
            currentRecording.recording.id === id &&
            !isGenerating &&
            !hasTriggeredGeneration.current
        ) {
            hasTriggeredGeneration.current = true;
            navigate(location.pathname, { replace: true, state: {} });
            void handleRegenerate();
        }
    }, [location.state?.triggerGeneration, currentRecording, isGenerating, id, location.pathname, navigate]);

    useEffect(() => {
        hasTriggeredGeneration.current = false;
    }, [id]);

    useEffect(() => {
        const generationState = useGenerationStore.getState();

        if (generationState.isGenerating && generationState.recordingId && generationState.recordingId !== id) {
            generationState.cancelGeneration();
            generationState.resetGeneration();
        }

        setShowRegenerationModal(false);
        setStepsForRegeneration([]);
    }, [id]);

    const copyScreenshotToPermanent = async (tempPath: string): Promise<string> => {
        if (!id || !currentRecording) {
            return tempPath;
        }

        try {
            const permanentPath = await invoke<string>("copy_screenshot_to_permanent", {
                tempPath,
                recordingId: id,
                recordingName: currentRecording.recording.name,
                customScreenshotPath: screenshotPath || null,
            });

            const lastBackslash = permanentPath.lastIndexOf("\\");
            const lastForwardSlash = permanentPath.lastIndexOf("/");
            const lastSlash = Math.max(lastBackslash, lastForwardSlash);
            const screenshotDir = lastSlash > 0 ? permanentPath.substring(0, lastSlash) : permanentPath;
            await invoke("register_asset_scope", { path: screenshotDir });

            return permanentPath;
        } catch (copyError) {
            console.error("Failed to copy screenshot to permanent location:", copyError);
            return tempPath;
        }
    };

    useEffect(() => {
        if (!isRecording) {
            return;
        }

        const unlistenStep = listen<any>("new-step", async (event) => {
            const newStep = event.payload;
            const tempId = `temp-${Date.now()}-${Math.random()}`;
            const recorderId: string | undefined = newStep.id;
            if (recorderId) {
                recorderIdToTempId.current.set(recorderId, tempId);
            }

            let finalScreenshotPath = newStep.screenshot;
            if (newStep.screenshot) {
                finalScreenshotPath = await copyScreenshotToPermanent(newStep.screenshot);
            }

            setLocalSteps((previousSteps) => {
                const nextSteps = [...previousSteps];
                const insertIndex = insertPosition !== null ? insertPosition : previousSteps.length;
                nextSteps.splice(insertIndex, 0, {
                    ...newStep,
                    id: tempId,
                    recording_id: id!,
                    screenshot_path: finalScreenshotPath,
                    order_index: insertIndex,
                });
                return nextSteps;
            });

            if (insertPosition !== null) {
                setInsertPosition((previousValue) => previousValue! + 1);
            }

            setHasUnsavedChanges(true);
        });

        // After-frame capture: the recorder emits this ~700ms after each new-step
        // (for non-capture steps). Match it back to the in-memory localStep by the
        // recorder's UUID, copy the temp file to permanent storage, and update.
        type StepAfterPayload = { step_id: string; after_screenshot_path: string };
        const unlistenStepAfter = listen<StepAfterPayload>("new-step-after", async (event) => {
            const { step_id, after_screenshot_path } = event.payload;
            const tempId = recorderIdToTempId.current.get(step_id);
            if (!tempId || !after_screenshot_path) return;

            // Move the temp file to permanent storage (same path scheme as the
            // primary screenshot) so the URL stays valid across app restarts.
            const permanentPath = await copyScreenshotToPermanent(after_screenshot_path);

            setLocalSteps((previousSteps) =>
                previousSteps.map((step) =>
                    step.id === tempId
                        ? { ...step, screenshot_after_path: permanentPath }
                        : step,
                ),
            );
            setHasUnsavedChanges(true);
        });

        // Video clip capture (8a) — animated GIF capturing the ~2s after the event.
        // Gated by the enableVideoClips setting in the recorder.
        type StepClipPayload = { step_id: string; clip_path: string };
        const unlistenStepClip = listen<StepClipPayload>("new-step-clip", async (event) => {
            const { step_id, clip_path } = event.payload;
            const tempId = recorderIdToTempId.current.get(step_id);
            if (!tempId || !clip_path) return;
            const permanentPath = await copyScreenshotToPermanent(clip_path);
            setLocalSteps((previousSteps) =>
                previousSteps.map((step) =>
                    step.id === tempId
                        ? { ...step, clip_path: permanentPath }
                        : step,
                ),
            );
            setHasUnsavedChanges(true);
        });

        const unlistenManualCapture = listen<string>("manual-capture-complete", async (event) => {
            const tempScreenshotPath = event.payload;
            const tempId = `temp-${Date.now()}-${Math.random()}`;
            const finalScreenshotPath = await copyScreenshotToPermanent(tempScreenshotPath);

            setLocalSteps((previousSteps) => {
                const nextSteps = [...previousSteps];
                const insertIndex = insertPosition !== null ? insertPosition : previousSteps.length;
                nextSteps.splice(insertIndex, 0, {
                    id: tempId,
                    recording_id: id!,
                    type_: "capture",
                    timestamp: Date.now(),
                    screenshot_path: finalScreenshotPath,
                    order_index: insertIndex,
                });
                return nextSteps;
            });

            if (insertPosition !== null) {
                setInsertPosition((previousValue) => previousValue! + 1);
            }

            setHasUnsavedChanges(true);
        });

        return () => {
            unlistenStep.then((stopListening) => stopListening());
            unlistenStepAfter.then((stopListening) => stopListening());
            unlistenStepClip.then((stopListening) => stopListening());
            unlistenManualCapture.then((stopListening) => stopListening());
            // Clear the lookup table so a subsequent recording session starts fresh.
            recorderIdToTempId.current.clear();
        };
    }, [isRecording, insertPosition, id, currentRecording, screenshotPath]);

    useEffect(() => {
        const unlistenStop = listen("hotkey-stop", async () => {
            if (isRecording) {
                await stopRecordingMore();
            }
        });

        return () => {
            unlistenStop.then((stopListening) => stopListening());
        };
    }, [isRecording]);

    const handleRegenerate = async () => {
        if (!currentRecording || !id) {
            return;
        }

        const targetRecordingId = id;
        const targetRecordingName = currentRecording.recording.name;

        setError(null);
        const steps = mapStepsForAI(currentRecording.steps);
        setStepsForRegeneration(steps);
        setShowRegenerationModal(true);

        const abortController = startGeneration(targetRecordingId, steps.length);
        const { generateDocumentationStreaming } = await import("../lib/aiService");

        const callbacks: StreamingCallbacks = {
            onStepStart: (index) => updateStepStatus(index, "generating"),
            onTextChunk: (index, text) => appendStreamingText(index, text),
            onStepComplete: (index, text) => completeStep(index, text),
            onDocumentUpdate: (markdown) => updateDocument(markdown),
            onPolishStart: () => startPolishing(),
            onPolishComplete: (refined) => finishPolishing(refined),
            onError: (index, generationError) => {
                log.ai.error("Per-step generation failed", {
                    recordingId: targetRecordingId,
                    stepIndex: index,
                    ...describeError(generationError).metadata,
                });
                setStepError(index, generationError.message);
            },
            onComplete: async (finalMarkdown) => {
                const generationState = useGenerationStore.getState();
                if (generationState.recordingId !== targetRecordingId) {
                    console.warn("Generation completed for a different recording, discarding result");
                    finishGeneration();
                    return;
                }

                await saveDocumentation(targetRecordingId, finalMarkdown);
                await getRecording(targetRecordingId);
                finishGeneration();
            },
        };

        try {
            await generateDocumentationStreaming(
                steps,
                {
                    apiKey: openaiApiKey,
                    baseUrl: openaiBaseUrl,
                    model: openaiModel,
                    workflowTitle: targetRecordingName,
                },
                callbacks,
                abortController.signal,
            );
        } catch (generationError) {
            if (generationError instanceof DOMException && generationError.name === "AbortError") {
                setShowRegenerationModal(false);
                resetGeneration();
                return;
            }

            const described = describeError(generationError);
            const errorMessage = described.message || "Failed to regenerate documentation";
            log.ai.error("Documentation generation failed", {
                recordingId: targetRecordingId,
                recordingName: targetRecordingName,
                stepCount: steps.length,
                model: openaiModel,
                ...described.metadata,
            });
            // Surface the full provider error as a persistent toast so the user
            // can read it and copy it to a bug report. The same message is now
            // also on disk under <appdata>/stepsnap/logs/ai.<date>.log.
            useToastStore.getState().showToast({
                title: "AI generation failed",
                message: errorMessage,
                variant: "error",
                durationMs: 15000,
                persist: true,
            });
            setError(errorMessage);
            setShowRegenerationModal(false);
            resetGeneration();
        }
    };

    const handleCancelRegeneration = () => {
        cancelGeneration();
        setShowRegenerationModal(false);
    };

    const handleCloseRegeneration = () => {
        resetGeneration();
        setShowRegenerationModal(false);
    };

    const handleStartEdit = () => {
        setEditedContent(currentRecording?.recording.documentation || "");
        setIsEditing(true);
    };

    const handleSaveEdit = async () => {
        if (!id) {
            return;
        }

        setError(null);
        try {
            await saveDocumentation(id, editedContent);
            await getRecording(id);
            setIsEditing(false);
        } catch (saveError) {
            const errorMessage = saveError instanceof Error ? saveError.message : "Failed to save documentation";
            setError(errorMessage);
        }
    };

    const handleCancelEdit = () => {
        setIsEditing(false);
        setEditedContent("");
    };

    const cleanupTempScreenshots = async () => {
        const tempStepsWithScreenshots = localSteps.filter(
            (step) => step.id.startsWith("temp-") && step.screenshot_path,
        );

        for (const step of tempStepsWithScreenshots) {
            try {
                await invoke("delete_screenshot", { path: step.screenshot_path });
            } catch (cleanupError) {
                console.error("Failed to delete temp screenshot:", cleanupError);
            }
        }
    };

    const confirmDiscardUnsavedChanges = async () => {
        if (!hasUnsavedChanges) {
            return true;
        }

        const confirmed = window.confirm("You have unsaved changes. Do you want to discard them?");
        if (!confirmed) {
            return false;
        }

        await cleanupTempScreenshots();
        return true;
    };

    const handleNavigate = async (page: "recordings" | "settings") => {
        const canNavigate = await confirmDiscardUnsavedChanges();
        if (!canNavigate) {
            return;
        }

        if (page === "recordings") {
            navigate("/");
            return;
        }

        navigate("/settings");
    };

    const handleReorderSteps = (activeId: string, overId: string) => {
        const oldIndex = localSteps.findIndex((step) => step.id === activeId);
        const newIndex = localSteps.findIndex((step) => step.id === overId);

        if (oldIndex === -1 || newIndex === -1) {
            return;
        }

        const reorderedSteps = [...localSteps];
        const [movedStep] = reorderedSteps.splice(oldIndex, 1);
        reorderedSteps.splice(newIndex, 0, movedStep);
        setLocalSteps(reorderedSteps);
        setHasUnsavedChanges(true);
    };

    const handleDeleteStep = async (stepId: string) => {
        setDeletingStepId(stepId);

        const stepToDelete = localSteps.find((step) => step.id === stepId);
        if (stepToDelete?.id.startsWith("temp-") && stepToDelete.screenshot_path) {
            try {
                await invoke("delete_screenshot", { path: stepToDelete.screenshot_path });
            } catch (deleteError) {
                console.error("Failed to delete temp screenshot:", deleteError);
            }
        }

        setLocalSteps((previousSteps) => previousSteps.filter((step) => step.id !== stepId));
        setDeletedStepIds((previousIds) => new Set(previousIds).add(stepId));
        setHasUnsavedChanges(true);
        window.setTimeout(() => setDeletingStepId(null), 100);
    };

    const handleSelectInsertPosition = (index: number) => {
        if (isSelectingPosition && insertPosition === index) {
            setInsertPosition(null);
            setIsSelectingPosition(false);
            return;
        }
        setInsertPosition(index);
        setIsSelectingPosition(true);
    };

    const startRecordingMore = async () => {
        if (insertPosition === null) {
            setError("Please select where to insert new steps first");
            return;
        }

        try {
            await invoke("start_recording");
            setIsRecording(true);
            setIsSelectingPosition(false);
            await getCurrentWindow().minimize();
        } catch (startError) {
            console.error("Failed to start recording:", startError);
            setError(startError instanceof Error ? startError.message : "Failed to start recording");
        }
    };

    const stopRecordingMore = async () => {
        try {
            await invoke("stop_recording");
            setIsRecording(false);
            await getCurrentWindow().unminimize();
            await getCurrentWindow().setFocus();
        } catch (stopError) {
            console.error("Failed to stop recording:", stopError);
            setError(stopError instanceof Error ? stopError.message : "Failed to stop recording");
        }
    };

    const handleSaveChanges = async () => {
        if (!id || !hasUnsavedChanges) {
            return;
        }

        setSaving(true);
        setError(null);

        try {
            for (const stepId of deletedStepIds) {
                await invoke("delete_step", { stepId });
            }

            const recording = currentRecording?.recording;
            if (!recording) {
                throw new Error("Recording not found");
            }

            const stepsToSave = localSteps
                .map((step, index) => ({ step, index }))
                .filter(({ step }) => step.id.startsWith("temp-"))
                .map(({ step, index }) => ({
                    type_: step.type_,
                    x: step.x,
                    y: step.y,
                    text: step.text,
                    timestamp: step.timestamp,
                    screenshot: step.screenshot_path,
                    screenshot_after: step.screenshot_after_path,
                    element_name: step.element_name,
                    element_type: step.element_type,
                    element_value: step.element_value,
                    app_name: step.app_name,
                    description: step.description,
                    is_cropped: step.is_cropped,
                    title: step.title,
                    order_index: index,
                    screenshot_is_permanent: true,
                    input_source: step.input_source,
                    identified_element_json: step.identified_element_json,
                    clip_path: step.clip_path,
                }));

            if (stepsToSave.length > 0) {
                await invoke("save_steps_with_path", {
                    recordingId: id,
                    recordingName: recording.name,
                    steps: stepsToSave,
                    screenshotPath: screenshotPath || null,
                });
            }

            const existingSteps = localSteps
                .map((step, index) => ({ step, index }))
                .filter(({ step }) => !step.id.startsWith("temp-"));

            if (existingSteps.length > 0) {
                await invoke("reorder_steps", {
                    recordingId: id,
                    stepIds: existingSteps.map(({ step }) => step.id),
                });
            }

            await getRecording(id);

            const refreshedRecording = useRecordingsStore.getState().currentRecording;
            if (refreshedRecording) {
                const allStepIds = refreshedRecording.steps
                    .sort((left, right) => left.order_index - right.order_index)
                    .map((step) => step.id);

                await invoke("reorder_steps", {
                    recordingId: id,
                    stepIds: allStepIds,
                });

                await getRecording(id);
            }

            setDeletedStepIds(new Set());
            setHasUnsavedChanges(false);
            setInsertPosition(null);
            setIsSelectingPosition(false);
        } catch (saveError) {
            const errorMessage = saveError instanceof Error ? saveError.message : "Failed to save changes";
            setError(errorMessage);
        } finally {
            setSaving(false);
        }
    };

    const handleDiscardChanges = async () => {
        if (!currentRecording?.steps) {
            return;
        }

        await cleanupTempScreenshots();
        setLocalSteps(currentRecording.steps);
        setDeletedStepIds(new Set());
        setHasUnsavedChanges(false);
        setInsertPosition(null);
        setIsSelectingPosition(false);
    };

    const handleUpdateDescription = (stepId: string, description: string) => {
        setLocalSteps((previousSteps) =>
            previousSteps.map((step) =>
                step.id === stepId ? { ...step, description } : step,
            ),
        );

        if (stepId.startsWith("temp-")) {
            setHasUnsavedChanges(true);
            return;
        }

        const existingTimer = descriptionSaveTimers.current.get(stepId);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const timer = setTimeout(async () => {
            descriptionSaveTimers.current.delete(stepId);
            try {
                await invoke("update_step_description", { stepId, description });
                if (id) {
                    await getRecording(id);
                }
            } catch (updateError) {
                console.error("Failed to update step description:", updateError);
                setError(updateError instanceof Error ? updateError.message : "Failed to update step description");
            }
        }, 400);

        descriptionSaveTimers.current.set(stepId, timer);
    };

    const handleUpdateTitle = (stepId: string, title: string) => {
        setLocalSteps((previousSteps) =>
            previousSteps.map((step) =>
                step.id === stepId ? { ...step, title } : step,
            ),
        );

        if (stepId.startsWith("temp-")) {
            setHasUnsavedChanges(true);
            return;
        }

        const existingTimer = titleSaveTimers.current.get(stepId);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const timer = setTimeout(async () => {
            titleSaveTimers.current.delete(stepId);
            try {
                await invoke("update_step_title", { stepId, title });
                if (id) {
                    await getRecording(id);
                }
            } catch (updateError) {
                console.error("Failed to update step title:", updateError);
                setError(updateError instanceof Error ? updateError.message : "Failed to update step title");
            }
        }, 400);

        titleSaveTimers.current.set(stepId, timer);
    };

    const handleCropSave = async (croppedImageBase64: string) => {
        if (!croppingStep || !currentRecording) {
            return;
        }

        const stepId = croppingStep.stepId;
        const target = croppingStep.target;
        const step = currentRecording.steps.find((currentStep) => currentStep.id === stepId);
        const targetPath = target === "after" ? step?.screenshot_after_path : step?.screenshot_path;
        if (!step || !targetPath) {
            return;
        }

        try {
            await invoke("save_cropped_image", {
                path: targetPath,
                base64Data: croppedImageBase64,
            });

            if (target === "after") {
                await invoke("update_step_after_screenshot", {
                    stepId,
                    screenshotAfterPath: targetPath,
                });
            } else {
                await invoke("update_step_screenshot", {
                    stepId,
                    screenshotPath: targetPath,
                    isCropped: true,
                });
            }

            setCropTimestamps((previousTimestamps) => ({ ...previousTimestamps, [stepId]: Date.now() }));

            if (id) {
                await getRecording(id);
            }
        } catch (cropError) {
            console.error("Failed to save cropped image:", cropError);
            setError(cropError instanceof Error ? cropError.message : "Failed to save cropped image");
        }

        setCroppingStep(null);
    };

    const handleStartEditName = () => {
        if (!currentRecording) {
            return;
        }

        setEditedName(currentRecording.recording.name);
        setIsEditingName(true);
    };

    const handleSaveName = async () => {
        if (!id || !editedName.trim() || nameSaving) {
            return;
        }

        if (editedName.trim() === currentRecording?.recording.name) {
            setIsEditingName(false);
            return;
        }

        setNameSaving(true);
        try {
            await updateRecordingName(id, editedName.trim());
            await getRecording(id);
            setIsEditingName(false);
        } catch (renameError) {
            console.error("Failed to rename recording:", renameError);
            setError(renameError instanceof Error ? renameError.message : "Failed to rename recording");
        } finally {
            setNameSaving(false);
        }
    };

    const handleCancelEditName = () => {
        setIsEditingName(false);
        setEditedName("");
    };

    const handleNameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
            event.preventDefault();
            void handleSaveName();
            return;
        }

        if (event.key === "Escape") {
            event.preventDefault();
            handleCancelEditName();
        }
    };

    const croppingStepRow = croppingStep
        ? currentRecording?.steps.find((step) => step.id === croppingStep.stepId)
        : null;
    const croppingSourcePath = croppingStep
        ? (croppingStep.target === "after"
            ? croppingStepRow?.screenshot_after_path
            : croppingStepRow?.screenshot_path)
        : undefined;

    const isDocumentationStale = !!(
        currentRecording?.recording.documentation &&
        currentRecording.recording.documentation_generated_at &&
        currentRecording.recording.updated_at > currentRecording.recording.documentation_generated_at
    );

    if (!id) {
        return (
            <div className="flex h-screen items-center justify-center text-white">
                <div className="text-white/50">Invalid recording ID</div>
            </div>
        );
    }

    if (loading && !currentRecording) {
        return (
            <div className="flex h-screen items-center justify-center text-white">
                <div className="text-white/50">Loading recording...</div>
            </div>
        );
    }

    if (!currentRecording) {
        return (
            <div className="flex h-screen items-center justify-center text-white">
                <div className="text-white/50">Recording not found</div>
            </div>
        );
    }

    return (
        <div className="flex h-screen text-white">
            <Sidebar activePage="recording-detail" onNavigate={handleNavigate} />

            {croppingSourcePath && (
                <Suspense fallback={<DeferredModalFallback label="Loading image editor..." />}>
                    <LazyImageEditor
                        imageSrc={convertFileSrc(croppingSourcePath)}
                        onSave={handleCropSave}
                        onCancel={() => setCroppingStep(null)}
                    />
                </Suspense>
            )}

            {showRegenerationModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8">
                    <div className="glass-surface-1 h-[80vh] w-full max-w-6xl rounded-xl p-6">
                        <Suspense fallback={<DeferredPanelFallback label="Loading generation view..." />}>
                            <LazyGenerationSplitView
                                steps={stepsForRegeneration}
                                onCancel={handleCancelRegeneration}
                                onClose={handleCloseRegeneration}
                            />
                        </Suspense>
                    </div>
                </div>
            )}

            <main className="scroll-container flex-1 overflow-y-auto overflow-x-hidden p-8">
                <div className="mb-6 flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <Tooltip content="Go back">
                            <button
                                aria-label="Go back"
                                onClick={async () => {
                                    const canNavigate = await confirmDiscardUnsavedChanges();
                                    if (canNavigate) {
                                        navigate("/recordings");
                                    }
                                }}
                                className="rounded-md p-2 transition-colors hover:bg-white/10"
                            >
                                <ArrowLeft size={18} />
                            </button>
                        </Tooltip>
                        <div>
                            {isEditingName ? (
                                <div className="flex items-center gap-2">
                                    <input
                                        type="text"
                                        value={editedName}
                                        onChange={(event) => setEditedName(event.target.value)}
                                        onBlur={() => {
                                            void handleSaveName();
                                        }}
                                        onKeyDown={handleNameKeyDown}
                                        disabled={nameSaving}
                                        autoFocus
                                        aria-label="Recording name"
                                        placeholder="Enter recording name"
                                        className="min-w-[200px] rounded-md border border-white/20 bg-white/10 px-2 py-1 text-2xl font-bold focus:border-[#2721E8] focus:outline-none disabled:opacity-50"
                                    />
                                    {nameSaving && <Spinner size="sm" />}
                                </div>
                            ) : (
                                <Tooltip content="Click to rename">
                                    <h2
                                        onClick={handleStartEditName}
                                        className="cursor-pointer text-2xl font-bold transition-colors hover:text-white/80"
                                    >
                                        {currentRecording.recording.name}
                                    </h2>
                                </Tooltip>
                            )}
                            <p className="text-sm text-white/50">
                                {currentRecording.steps.length} steps • Created {new Date(currentRecording.recording.created_at).toLocaleDateString()}
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        {activeTab === "steps" && (
                            <>
                                {hasUnsavedChanges && (
                                    <>
                                        <Tooltip content="Discard changes">
                                            <button
                                                aria-label="Discard changes"
                                                onClick={() => {
                                                    void handleDiscardChanges();
                                                }}
                                                className="rounded-md bg-white/10 p-2 transition-colors hover:bg-white/15"
                                            >
                                                <XCircle size={18} />
                                            </button>
                                        </Tooltip>
                                        <Tooltip content="Save changes">
                                            <button
                                                onClick={() => {
                                                    void handleSaveChanges();
                                                }}
                                                disabled={saving}
                                                className="flex items-center gap-2 rounded-md bg-green-600 px-3 py-2 transition-colors hover:bg-green-700 disabled:opacity-50"
                                            >
                                                {saving ? <Spinner size="sm" /> : <Save size={18} />}
                                                <span className="text-sm font-medium">Save Changes</span>
                                            </button>
                                        </Tooltip>
                                    </>
                                )}
                                {insertPosition !== null && !isRecording && (
                                    <Tooltip content="Start recording more steps">
                                        <button
                                            onClick={() => {
                                                void startRecordingMore();
                                            }}
                                            className="flex items-center gap-2 rounded-md bg-green-600 px-3 py-2 transition-colors hover:bg-green-700"
                                        >
                                            <Play size={18} />
                                            <span className="text-sm font-medium">Record More</span>
                                        </button>
                                    </Tooltip>
                                )}
                                {isRecording && (
                                    <Tooltip content="Stop recording">
                                        <button
                                            onClick={() => {
                                                void stopRecordingMore();
                                            }}
                                            className="flex animate-pulse items-center gap-2 rounded-md bg-red-600 px-3 py-2 transition-colors hover:bg-red-700"
                                        >
                                            <Square size={18} />
                                            <span className="text-sm font-medium">Stop Recording</span>
                                        </button>
                                    </Tooltip>
                                )}
                            </>
                        )}
                        {activeTab === "docs" && currentRecording.recording.documentation && (
                            <>
                                {isEditing ? (
                                    <>
                                        <Tooltip content="Cancel">
                                            <button
                                                aria-label="Cancel editing"
                                                onClick={handleCancelEdit}
                                                className="rounded-md p-2 transition-colors hover:bg-white/10"
                                            >
                                                <X size={18} />
                                            </button>
                                        </Tooltip>
                                        <Tooltip content="Save">
                                            <button
                                                aria-label="Save documentation"
                                                onClick={() => {
                                                    void handleSaveEdit();
                                                }}
                                                className="rounded-md bg-green-600 p-2 transition-colors hover:bg-green-700"
                                            >
                                                <Check size={18} />
                                            </button>
                                        </Tooltip>
                                    </>
                                ) : (
                                    <>
                                        <Tooltip content="Edit documentation">
                                            <button
                                                aria-label="Edit documentation"
                                                onClick={handleStartEdit}
                                                className="rounded-md bg-white/10 p-2 transition-colors hover:bg-white/15"
                                            >
                                                <Pencil size={18} />
                                            </button>
                                        </Tooltip>
                                        <ExportDropdown
                                            markdown={currentRecording.recording.documentation}
                                            fileName={currentRecording.recording.name}
                                        />
                                    </>
                                )}
                            </>
                        )}
                        {!isEditing && (
                            <Tooltip content="Regenerate documentation">
                                <button
                                    aria-label="Regenerate documentation"
                                    onClick={() => {
                                        void handleRegenerate();
                                    }}
                                    disabled={isGenerating}
                                    className="rounded-md bg-purple-600 p-2 transition-colors hover:bg-purple-700 disabled:opacity-50"
                                >
                                    <Wand2 size={18} />
                                </button>
                            </Tooltip>
                        )}
                    </div>
                </div>

                <div className="glass-surface-1 mb-6 flex w-fit gap-1 rounded-xl p-1">
                    <button
                        onClick={() => setActiveTab("docs")}
                        className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                            activeTab === "docs" ? "bg-[#2721E8]/30 text-white" : "text-white/60 hover:text-white"
                        }`}
                    >
                        Documentation
                    </button>
                    <button
                        onClick={() => setActiveTab("steps")}
                        className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                            activeTab === "steps" ? "bg-[#2721E8]/30 text-white" : "text-white/60 hover:text-white"
                        }`}
                    >
                        Steps
                    </button>
                </div>

                {error && (
                    <div className="mb-6 rounded-lg border border-red-500/50 bg-red-500/20 p-4">
                        <p className="text-sm text-red-400">{error}</p>
                        <button
                            onClick={() => setError(null)}
                            className="mt-2 text-xs text-red-300 hover:text-red-200"
                        >
                            Dismiss
                        </button>
                    </div>
                )}

                {activeTab === "docs" ? (
                    <div className={`glass-surface-scroll rounded-xl print-content ${isEditing ? "" : "p-6"}`}>
                        {isDocumentationStale && !isEditing && (
                            <div className="mb-4 flex items-center justify-between rounded-lg border border-amber-500/50 bg-amber-500/20 p-3">
                                <div className="flex items-center gap-2">
                                    <AlertTriangle size={18} className="text-amber-400" />
                                    <span className="text-sm text-amber-200">
                                        Steps have been modified since documentation was generated.
                                    </span>
                                </div>
                                <button
                                    onClick={() => {
                                        void handleRegenerate();
                                    }}
                                    disabled={isGenerating}
                                    className="flex items-center gap-1 rounded-md bg-amber-500/30 px-3 py-1 text-sm text-amber-200 transition-colors hover:bg-amber-500/40 disabled:opacity-50"
                                >
                                    <Wand2 size={14} />
                                    Regenerate
                                </button>
                            </div>
                        )}
                        {currentRecording.recording.documentation ? (
                            isEditing ? (
                                <Suspense fallback={<DeferredPanelFallback label="Loading editor..." />}>
                                    <DocumentationEditor
                                        content={editedContent}
                                        onChange={setEditedContent}
                                    />
                                </Suspense>
                            ) : (
                                <MarkdownViewer
                                    content={currentRecording.recording.documentation}
                                    className="markdown-content scroll-optimized"
                                />
                            )
                        ) : (
                            <div className="py-12 text-center text-white/50">
                                <p>No documentation generated yet</p>
                                <button
                                    onClick={() => {
                                        void handleRegenerate();
                                    }}
                                    disabled={isGenerating}
                                    className="mx-auto mt-4 flex items-center gap-2 text-purple-500 hover:text-purple-400 disabled:opacity-50"
                                >
                                    Generate documentation
                                </button>
                            </div>
                        )}
                    </div>
                ) : (
                    <Suspense fallback={<DeferredPanelFallback label="Loading steps..." />}>
                        <StepsTab
                            steps={localSteps}
                            isSelectingPosition={isSelectingPosition}
                            insertPosition={insertPosition}
                            deletingStepId={deletingStepId}
                            cropTimestamps={cropTimestamps}
                            onDeleteStep={(stepId) => {
                                void handleDeleteStep(stepId);
                            }}
                            onCropStep={(stepId, target) => setCroppingStep({ stepId, target })}
                            onUpdateDescription={(stepId, description) => {
                                void handleUpdateDescription(stepId, description);
                            }}
                            onUpdateTitle={(stepId, title) => {
                                void handleUpdateTitle(stepId, title);
                            }}
                            onSelectInsertPosition={handleSelectInsertPosition}
                            onReorder={handleReorderSteps}
                        />
                    </Suspense>
                )}
            </main>
        </div>
    );
}
