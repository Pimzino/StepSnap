import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { MapPin, Plus } from "lucide-react";

import DraggableStepCard from "../../components/DraggableStepCard";
import type { Step } from "../../store/recordingsStore";

interface StepsTabProps {
    steps: Step[];
    isSelectingPosition: boolean;
    insertPosition: number | null;
    deletingStepId: string | null;
    cropTimestamps: Record<string, number>;
    onDeleteStep: (stepId: string) => void;
    onCropStep: (stepId: string, target: "before" | "after") => void;
    onUpdateDescription: (stepId: string, description: string) => void;
    onUpdateTitle?: (stepId: string, title: string) => void;
    onSelectInsertPosition: (index: number) => void;
    onReorder: (activeId: string, overId: string) => void;
}

export default function StepsTab({
    steps,
    isSelectingPosition,
    insertPosition,
    deletingStepId,
    cropTimestamps,
    onDeleteStep,
    onCropStep,
    onUpdateDescription,
    onUpdateTitle,
    onSelectInsertPosition,
    onReorder,
}: StepsTabProps) {
    const sensors = useSensors(
        useSensor(PointerSensor),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        }),
    );

    const renderInsertSlot = (index: number, isEnd: boolean = false) => {
        const isActive = isSelectingPosition && insertPosition === index;

        if (isActive) {
            return (
                <button
                    onClick={() => onSelectInsertPosition(index)}
                    title="Click again to cancel"
                    className="group relative flex w-full items-center justify-center py-2 text-green-400 transition-colors"
                >
                    <span className="h-px flex-1 bg-green-400" />
                    <span className="mx-3 inline-flex items-center gap-1.5 rounded-full border border-green-500 bg-green-500/15 px-3 py-1 text-xs font-medium text-green-400">
                        <MapPin size={12} />
                        Insert here
                    </span>
                    <span className="h-px flex-1 bg-green-400" />
                </button>
            );
        }

        return (
            <div className="relative flex w-full items-center justify-center py-1">
                <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-white/8" />
                <button
                    onClick={() => onSelectInsertPosition(index)}
                    className="relative inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-[#1a1718] px-3 py-1 text-xs font-medium text-white/60 hover:border-[#2721E8]/60 hover:bg-[#2721E8]/10 hover:text-white/90 transition-colors"
                >
                    <Plus size={12} />
                    {isEnd ? "Add step" : "Add step"}
                </button>
            </div>
        );
    };

    return (
        <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={({ active, over }) => {
                if (!over || active.id === over.id) {
                    return;
                }

                onReorder(String(active.id), String(over.id));
            }}
        >
            <SortableContext
                items={steps.map((step) => step.id)}
                strategy={verticalListSortingStrategy}
            >
                <div className="mx-auto flex w-full max-w-3xl flex-col">
                    {steps.map((step, index) => (
                        <div key={step.id}>
                            {renderInsertSlot(index)}
                            <DraggableStepCard
                                id={step.id}
                                step={step}
                                index={index}
                                onDelete={() => onDeleteStep(step.id)}
                                onCrop={(target) => onCropStep(step.id, target)}
                                onUpdateDescription={(description) => onUpdateDescription(step.id, description)}
                                onUpdateTitle={onUpdateTitle ? (title) => onUpdateTitle(step.id, title) : undefined}
                                isDeleting={deletingStepId === step.id}
                                cropTimestamp={cropTimestamps[step.id]}
                            />
                        </div>
                    ))}
                    {renderInsertSlot(steps.length, true)}
                </div>
            </SortableContext>
        </DndContext>
    );
}
