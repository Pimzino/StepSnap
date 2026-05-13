import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import ReactCrop, { Crop, PixelCrop, centerCrop, makeAspectCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import {
    X, Check, RotateCcw, MousePointer2, Crop as CropIcon,
    MoveRight, Square, Circle, Type, Pencil, EyeOff, Trash2, Palette, Pointer
} from 'lucide-react';
import * as fabric from 'fabric';
import Tooltip from './Tooltip';

// ============================================================================
// Types & Interfaces
// ============================================================================

interface ImageEditorProps {
    imageSrc: string;
    onSave: (croppedImageBase64: string) => void;
    onCancel: () => void;
}

type EditorMode = 'select' | 'crop' | 'annotate';
type AnnotationTool = 'select' | 'arrow' | 'rect' | 'circle' | 'text' | 'freehand' | 'blur';

interface ToolSettings {
    color: string;
    strokeWidth: number;
    fontSize: number;
}

// ============================================================================
// Constants
// ============================================================================

const COLORS = [
    '#FF3B30', // Red
    '#FF9500', // Orange
    '#FFCC00', // Yellow
    '#34C759', // Green
    '#007AFF', // Blue
    '#AF52DE', // Purple
    '#FFFFFF', // White
    '#000000', // Black
];

const DEFAULT_TOOL_SETTINGS: ToolSettings = {
    color: '#FF3B30',
    strokeWidth: 3,
    fontSize: 24,
};

// ============================================================================
// Custom Fabric.js Arrow Class
// ============================================================================

class FabricArrow extends fabric.Group {
    static type = 'arrow';

    constructor(points: [number, number, number, number], options: Partial<fabric.GroupProps> & { stroke?: string; strokeWidth?: number } = {}) {
        const [x1, y1, x2, y2] = points;
        const stroke = options.stroke || '#FF3B30';
        const strokeWidth = options.strokeWidth || 3;

        // Create the line
        const line = new fabric.Line([x1, y1, x2, y2], {
            stroke,
            strokeWidth,
            strokeLineCap: 'round',
        });

        // Calculate arrow head
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const headLength = 15 + strokeWidth * 2;
        const headAngle = Math.PI / 6;

        const arrowHead = new fabric.Polygon([
            { x: x2, y: y2 },
            { x: x2 - headLength * Math.cos(angle - headAngle), y: y2 - headLength * Math.sin(angle - headAngle) },
            { x: x2 - headLength * Math.cos(angle + headAngle), y: y2 - headLength * Math.sin(angle + headAngle) },
        ], {
            fill: stroke,
            stroke: stroke,
            strokeWidth: 1,
        });

        super([line, arrowHead], {
            ...options,
            originX: 'center',
            originY: 'center',
        });
    }
}

// Register the custom class with Fabric.js
fabric.classRegistry.setClass(FabricArrow, 'arrow');

// ============================================================================
// Helper Functions
// ============================================================================

function centerAspectCrop(mediaWidth: number, mediaHeight: number) {
    return centerCrop(
        makeAspectCrop(
            {
                unit: '%',
                width: 90,
            },
            mediaWidth / mediaHeight,
            mediaWidth,
            mediaHeight,
        ),
        mediaWidth,
        mediaHeight,
    );
}

// Pixelate a region of an image for blur/redact effect
// Uses adaptive pixel size based on region dimensions for optimal visual effect
function createPixelatedRect(
    left: number,
    top: number,
    width: number,
    height: number,
    sourceImage: HTMLImageElement,
    canvasWidth: number,
    canvasHeight: number
): fabric.Group {
    // Adaptive pixel size: larger regions get larger pixels for better performance
    // and visual consistency, smaller regions get smaller pixels for finer detail
    const minDimension = Math.min(width, height);
    const pixelSize = Math.max(8, Math.min(20, Math.floor(minDimension / 10)));

    const rects: fabric.Rect[] = [];

    // Create a temporary canvas to sample colors
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = sourceImage.naturalWidth;
    tempCanvas.height = sourceImage.naturalHeight;
    const tempCtx = tempCanvas.getContext('2d');

    if (!tempCtx) {
        // Fallback to a solid gray rect if we can't sample
        const fallbackRect = new fabric.Rect({
            left: 0,
            top: 0,
            width,
            height,
            fill: 'rgba(100, 100, 100, 0.95)',
        });
        return new fabric.Group([fallbackRect], {
            left,
            top,
            originX: 'left',
            originY: 'top',
        });
    }

    tempCtx.drawImage(sourceImage, 0, 0);

    // Calculate scale between canvas display and natural image size
    // The canvas now matches the rendered image dimensions exactly
    const scaleX = sourceImage.naturalWidth / canvasWidth;
    const scaleY = sourceImage.naturalHeight / canvasHeight;

    // Sample and create pixelated blocks
    for (let y = 0; y < height; y += pixelSize) {
        for (let x = 0; x < width; x += pixelSize) {
            // Sample from the center of each pixel block
            const sampleX = Math.floor((left + x + pixelSize / 2) * scaleX);
            const sampleY = Math.floor((top + y + pixelSize / 2) * scaleY);

            // Clamp sample coordinates to image bounds
            const clampedX = Math.max(0, Math.min(sampleX, sourceImage.naturalWidth - 1));
            const clampedY = Math.max(0, Math.min(sampleY, sourceImage.naturalHeight - 1));

            let color = '#808080'; // Default fallback color

            try {
                const pixel = tempCtx.getImageData(clampedX, clampedY, 1, 1).data;
                color = `rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`;
            } catch {
                // Use fallback color on error
            }

            const blockWidth = Math.min(pixelSize, width - x);
            const blockHeight = Math.min(pixelSize, height - y);

            rects.push(new fabric.Rect({
                left: x,
                top: y,
                width: blockWidth,
                height: blockHeight,
                fill: color,
                stroke: color,
                strokeWidth: 0,
            }));
        }
    }

    // Create the group and mark it as a blur region for identification
    const group = new fabric.Group(rects, {
        left,
        top,
        originX: 'left',
        originY: 'top',
    });

    // Add custom property to identify this as a blur region
    (group as fabric.Group & { isBlurRegion?: boolean }).isBlurRegion = true;

    return group;
}

// ============================================================================
// Sub-Components
// ============================================================================

interface ToolbarButtonProps {
    icon: React.ReactNode;
    label: string;
    active?: boolean;
    onClick: () => void;
    disabled?: boolean;
}

function ToolbarButton({ icon, label, active, onClick, disabled }: ToolbarButtonProps) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            className={`
                flex flex-col items-center gap-1 px-3 py-2 rounded-lg transition-colors
                ${active
                    ? 'bg-[#2721E8] text-white'
                    : 'text-gray-300 hover:bg-white/10 hover:text-white'
                }
                ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
            `}
        >
            {icon}
            <span className="text-[10px] font-medium">{label}</span>
        </button>
    );
}

interface ColorPickerProps {
    currentColor: string;
    onColorChange: (color: string) => void;
}

function ColorPicker({ currentColor, onColorChange }: ColorPickerProps) {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });

    useEffect(() => {
        if (isOpen && containerRef.current) {
            const rect = containerRef.current.getBoundingClientRect();
            setDropdownPosition({
                top: rect.top - 8, // Position above the button with small gap
                left: rect.left + rect.width / 2, // Center horizontally
            });
        }
    }, [isOpen]);

    // Close dropdown when clicking outside
    useEffect(() => {
        if (!isOpen) return;

        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            // Check if click is inside the color picker (button or dropdown)
            if (target.closest('[data-color-picker]')) {
                return;
            }
            setIsOpen(false);
        };

        // Use setTimeout to avoid immediate trigger on the same click that opened it
        const timeoutId = setTimeout(() => {
            document.addEventListener('mousedown', handleClickOutside);
        }, 0);

        return () => {
            clearTimeout(timeoutId);
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isOpen]);

    const handleColorSelect = (color: string) => {
        onColorChange(color);
        setIsOpen(false);
    };

    return (
        <div className="relative" ref={containerRef} data-color-picker>
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="flex flex-col items-center gap-1 px-3 py-2 rounded-lg text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
            >
                <div className="relative">
                    <Palette size={20} />
                    {/* eslint-disable-next-line react/forbid-dom-props -- Dynamic color value requires inline style */}
                    <div
                        className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[#1a1a1a]"
                        style={{ backgroundColor: currentColor }}
                    />
                </div>
                <span className="text-[10px] font-medium">Color</span>
            </button>

            {isOpen && createPortal(
                // eslint-disable-next-line react/forbid-dom-props -- Dynamic positioning requires inline style
                <div
                    data-color-picker
                    className="fixed p-2 bg-[#2a2a2a] rounded-lg shadow-xl border border-white/10 grid grid-cols-4 gap-1 z-[100] -translate-x-1/2 -translate-y-full"
                    style={{
                        top: dropdownPosition.top,
                        left: dropdownPosition.left,
                    }}
                >
                    {COLORS.map((color) => (
                        <Tooltip key={color} content={`Select color ${color}`}>
                            <button
                                onMouseDown={(e) => {
                                    e.preventDefault(); // Prevent focus loss
                                    e.stopPropagation();
                                    handleColorSelect(color);
                                }}
                                className={`w-7 h-7 rounded-md border-2 transition-transform hover:scale-110 ${currentColor === color ? 'border-white' : 'border-transparent'
                                    }`}
                                // eslint-disable-next-line react/forbid-dom-props -- Dynamic color value requires inline style
                                style={{ backgroundColor: color }}
                            />
                        </Tooltip>
                    ))}
                </div>,
                document.body
            )}
        </div>
    );
}

interface StrokeWidthPickerProps {
    currentWidth: number;
    onWidthChange: (width: number) => void;
}

function StrokeWidthPicker({ currentWidth, onWidthChange }: StrokeWidthPickerProps) {
    return (
        <div className="flex items-center gap-2 px-3 py-1">
            <span className="text-[10px] text-gray-400">Width</span>
            <input
                type="range"
                min="1"
                max="10"
                value={currentWidth}
                onChange={(e) => onWidthChange(Number(e.target.value))}
                aria-label="Stroke width"
                className="w-16 h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-[#2721E8]"
            />
            <span className="text-[10px] text-gray-300 w-4">{currentWidth}</span>
        </div>
    );
}

// ============================================================================
// Main Component
// ============================================================================

export default function ImageEditor({ imageSrc, onSave, onCancel }: ImageEditorProps) {
    // Mode & Tool State
    const [mode, setMode] = useState<EditorMode>('crop');
    const [activeTool, setActiveTool] = useState<AnnotationTool>('arrow');
    const [toolSettings, setToolSettings] = useState<ToolSettings>(DEFAULT_TOOL_SETTINGS);

    // Crop State
    const [crop, setCrop] = useState<Crop>();
    const [completedCrop, setCompletedCrop] = useState<PixelCrop>();

    // Refs
    const imgRef = useRef<HTMLImageElement>(null);
    const fabricCanvasRef = useRef<fabric.Canvas | null>(null);
    const canvasContainerRef = useRef<HTMLDivElement>(null);
    const isDrawingRef = useRef(false);
    const drawStartRef = useRef<{ x: number; y: number } | null>(null);
    const currentShapeRef = useRef<fabric.Object | null>(null);

    // Refs for tool settings (so event handlers always get latest values)
    const toolSettingsRef = useRef<ToolSettings>(toolSettings);
    const activeToolRef = useRef<AnnotationTool>(activeTool);

    // Keep refs in sync with state
    toolSettingsRef.current = toolSettings;
    activeToolRef.current = activeTool;

    // Working image state (after crop is applied)
    const [workingImageSrc, setWorkingImageSrc] = useState(imageSrc);

    // ========================================================================
    // Crop Handlers
    // ========================================================================

    const onImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
        const { width, height } = e.currentTarget;
        setCrop(centerAspectCrop(width, height));
    }, []);

    const handleResetCrop = () => {
        if (cropApplied) {
            // If crop was applied, revert to original image
            revertCrop();
        } else if (imgRef.current) {
            // Just reset the crop selection
            const { width, height } = imgRef.current;
            setCrop(centerAspectCrop(width, height));
        }
    };

    // Track if crop has been applied to the current working image
    const [cropApplied, setCropApplied] = useState(false);

    const applyCrop = useCallback(async () => {
        if (!completedCrop || !imgRef.current) return;

        const image = imgRef.current;
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const scaleX = image.naturalWidth / image.width;
        const scaleY = image.naturalHeight / image.height;

        canvas.width = completedCrop.width * scaleX;
        canvas.height = completedCrop.height * scaleY;

        ctx.drawImage(
            image,
            completedCrop.x * scaleX,
            completedCrop.y * scaleY,
            completedCrop.width * scaleX,
            completedCrop.height * scaleY,
            0,
            0,
            canvas.width,
            canvas.height
        );

        const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
        setWorkingImageSrc(dataUrl);
        setCropApplied(true);
        // Clear the crop selection since it's been applied
        setCrop(undefined);
        setCompletedCrop(undefined);
    }, [completedCrop]);

    // Revert crop to original image
    const revertCrop = useCallback(() => {
        setWorkingImageSrc(imageSrc);
        setCropApplied(false);
        // Clear any existing annotations when reverting
        if (fabricCanvasRef.current) {
            fabricCanvasRef.current.clear();
        }
    }, [imageSrc]);

    // ========================================================================
    // Fabric.js Canvas Setup
    // ========================================================================

    useEffect(() => {
        if (mode !== 'annotate' || !canvasContainerRef.current) return;

        // Wait for the image to load in the container
        const setupCanvas = () => {
            const container = canvasContainerRef.current;
            if (!container) return;

            const img = container.querySelector('img');
            if (!img || !img.complete) {
                // Wait for image to load
                img?.addEventListener('load', setupCanvas);
                return;
            }

            // Clean up existing canvas and its wrapper
            if (fabricCanvasRef.current) {
                fabricCanvasRef.current.dispose();
                fabricCanvasRef.current = null;
            }

            // Remove any existing fabric canvas wrapper from previous sessions
            const existingWrapper = container.querySelector('.canvas-container');
            if (existingWrapper) {
                existingWrapper.remove();
            }

            // Get image dimensions
            const imgWidth = img.offsetWidth;
            const imgHeight = img.offsetHeight;

            // Create fresh canvas element
            const canvasEl = document.createElement('canvas');
            canvasEl.id = 'fabric-canvas';
            container.appendChild(canvasEl);

            // Create Fabric canvas matching the image dimensions
            const fabricCanvas = new fabric.Canvas(canvasEl, {
                width: imgWidth,
                height: imgHeight,
                selection: true,
                preserveObjectStacking: true,
            });

            // Set up cursor styles for object manipulation
            fabricCanvas.hoverCursor = 'move';
            fabricCanvas.moveCursor = 'grabbing';
            fabricCanvas.defaultCursor = 'default';
            fabricCanvas.freeDrawingCursor = 'crosshair';

            // Set cursor styles for control corners
            fabric.FabricObject.prototype.cornerStyle = 'circle';
            fabric.FabricObject.prototype.cornerSize = 10;
            fabric.FabricObject.prototype.transparentCorners = false;
            fabric.FabricObject.prototype.cornerColor = '#2721E8';
            fabric.FabricObject.prototype.borderColor = '#2721E8';

            // Fabric.js wraps the canvas in a container div with class 'canvas-container'
            // We need to position this wrapper absolutely over the image
            const fabricWrapper = canvasEl.parentElement;
            if (fabricWrapper && fabricWrapper.classList.contains('canvas-container')) {
                fabricWrapper.style.position = 'absolute';
                fabricWrapper.style.top = '0';
                fabricWrapper.style.left = '0';
                fabricWrapper.style.zIndex = '10';
            }

            fabricCanvasRef.current = fabricCanvas;

            // Set up drawing mode based on active tool
            updateCanvasMode(fabricCanvas, activeTool, toolSettings);
        };

        // Small delay to ensure DOM is ready
        setTimeout(setupCanvas, 50);

        return () => {
            if (fabricCanvasRef.current) {
                fabricCanvasRef.current.dispose();
                fabricCanvasRef.current = null;
            }
            // Also clean up the wrapper element
            const container = canvasContainerRef.current;
            if (container) {
                const wrapper = container.querySelector('.canvas-container');
                if (wrapper) {
                    wrapper.remove();
                }
            }
        };
    }, [mode, workingImageSrc]);

    // Update canvas mode when tool changes
    useEffect(() => {
        if (fabricCanvasRef.current && mode === 'annotate') {
            updateCanvasMode(fabricCanvasRef.current, activeTool, toolSettings);
        }
    }, [activeTool, toolSettings, mode]);

    // Update selected objects when color or stroke width changes
    useEffect(() => {
        const canvas = fabricCanvasRef.current;
        if (!canvas || mode !== 'annotate') return;

        const activeObjects = canvas.getActiveObjects();
        if (activeObjects.length === 0) return;

        activeObjects.forEach(obj => {
            // Skip blur regions (pixelated groups)
            if ((obj as fabric.Group & { isBlurRegion?: boolean }).isBlurRegion) return;

            // Update stroke color for shapes
            if (obj.stroke) {
                obj.set('stroke', toolSettings.color);
            }
            // Update fill color for text
            if (obj instanceof fabric.IText || obj instanceof fabric.Text) {
                obj.set('fill', toolSettings.color);
            }
            // Update stroke width for shapes (not text)
            if (obj.strokeWidth !== undefined && !(obj instanceof fabric.IText || obj instanceof fabric.Text)) {
                obj.set('strokeWidth', toolSettings.strokeWidth);
            }
            // Handle groups (like arrows)
            if (obj instanceof fabric.Group) {
                obj.getObjects().forEach(child => {
                    if (child.stroke) {
                        child.set('stroke', toolSettings.color);
                    }
                    if (child.fill && child.fill !== 'transparent') {
                        child.set('fill', toolSettings.color);
                    }
                    if (child.strokeWidth !== undefined) {
                        child.set('strokeWidth', toolSettings.strokeWidth);
                    }
                });
            }
        });

        canvas.renderAll();
    }, [toolSettings.color, toolSettings.strokeWidth, mode]);

    // Keyboard shortcuts for annotation mode
    useEffect(() => {
        if (mode !== 'annotate') return;

        const handleKeyDown = (e: KeyboardEvent) => {
            // Don't handle if user is typing in a text input
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
                return;
            }

            const canvas = fabricCanvasRef.current;
            if (!canvas) return;

            // Delete or Backspace to remove selected objects
            if (e.key === 'Delete' || e.key === 'Backspace') {
                const activeObjects = canvas.getActiveObjects();
                if (activeObjects.length > 0) {
                    e.preventDefault();
                    activeObjects.forEach(obj => canvas.remove(obj));
                    canvas.discardActiveObject();
                    canvas.renderAll();
                }
            }

            // Escape to deselect
            if (e.key === 'Escape') {
                canvas.discardActiveObject();
                canvas.renderAll();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [mode]);

    const updateCanvasMode = (canvas: fabric.Canvas, tool: AnnotationTool, settings: ToolSettings) => {
        // Reset drawing mode
        canvas.isDrawingMode = false;
        canvas.selection = true;
        canvas.defaultCursor = 'default';
        canvas.hoverCursor = 'move';
        canvas.moveCursor = 'move';
        (canvas as any).rotationCursor = 'crosshair';

        // Remove existing event listeners
        canvas.off('mouse:down');
        canvas.off('mouse:move');
        canvas.off('mouse:up');

        // Select tool - just allow selection and manipulation
        if (tool === 'select') {
            canvas.selection = true;
            canvas.defaultCursor = 'default';
            canvas.hoverCursor = 'move';
            // No special event handlers needed - fabric handles selection natively
            return;
        }

        if (tool === 'freehand') {
            canvas.isDrawingMode = true;
            canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
            canvas.freeDrawingBrush.color = settings.color;
            canvas.freeDrawingBrush.width = settings.strokeWidth;
            canvas.defaultCursor = 'crosshair';
            canvas.hoverCursor = 'move';
        } else if (tool === 'text') {
            canvas.defaultCursor = 'text';
            canvas.hoverCursor = 'move';
            canvas.on('mouse:down', (e) => {
                if (e.target) return; // Don't create new text if clicking existing object

                // Read from refs to get latest settings
                const currentSettings = toolSettingsRef.current;
                const pointer = canvas.getViewportPoint(e.e);
                const text = new fabric.IText('Click to edit', {
                    left: pointer.x,
                    top: pointer.y,
                    fontSize: currentSettings.fontSize,
                    fill: currentSettings.color,
                    fontFamily: 'Inter, system-ui, sans-serif',
                    fontWeight: '500',
                });
                canvas.add(text);
                canvas.setActiveObject(text);
                text.enterEditing();
                text.selectAll();
            });
        } else if (['arrow', 'rect', 'circle', 'blur'].includes(tool)) {
            canvas.selection = false;
            canvas.defaultCursor = 'crosshair';
            canvas.hoverCursor = 'move';

            canvas.on('mouse:down', (e) => {
                if (e.target) {
                    canvas.selection = true;
                    canvas.defaultCursor = 'move';
                    return;
                }

                // Read from refs to get latest settings and tool
                const currentSettings = toolSettingsRef.current;
                const currentTool = activeToolRef.current;

                isDrawingRef.current = true;
                const pointer = canvas.getViewportPoint(e.e);
                drawStartRef.current = { x: pointer.x, y: pointer.y };

                // Create preview shape
                if (currentTool === 'rect' || currentTool === 'blur') {
                    const rect = new fabric.Rect({
                        left: pointer.x,
                        top: pointer.y,
                        width: 0,
                        height: 0,
                        // Blur preview: semi-transparent with distinctive dashed border
                        fill: currentTool === 'blur' ? 'rgba(0, 0, 0, 0.3)' : 'transparent',
                        stroke: currentTool === 'blur' ? '#FF6B6B' : currentSettings.color,
                        strokeWidth: currentTool === 'blur' ? 2 : currentSettings.strokeWidth,
                        strokeDashArray: currentTool === 'blur' ? [8, 4] : undefined,
                        originX: 'left',
                        originY: 'top',
                    });
                    canvas.add(rect);
                    currentShapeRef.current = rect;
                } else if (currentTool === 'circle') {
                    const ellipse = new fabric.Ellipse({
                        left: pointer.x,
                        top: pointer.y,
                        rx: 0,
                        ry: 0,
                        fill: 'transparent',
                        stroke: currentSettings.color,
                        strokeWidth: currentSettings.strokeWidth,
                        originX: 'center',
                        originY: 'center',
                    });
                    canvas.add(ellipse);
                    currentShapeRef.current = ellipse;
                } else if (currentTool === 'arrow') {
                    // Arrow will be created on mouse up
                    currentShapeRef.current = null;
                }
            });

            canvas.on('mouse:move', (e) => {
                if (!isDrawingRef.current || !drawStartRef.current) return;

                const currentTool = activeToolRef.current;
                const pointer = canvas.getViewportPoint(e.e);
                const { x: startX, y: startY } = drawStartRef.current;

                if (currentTool === 'rect' || currentTool === 'blur') {
                    const rect = currentShapeRef.current as fabric.Rect;
                    if (rect) {
                        const width = Math.abs(pointer.x - startX);
                        const height = Math.abs(pointer.y - startY);
                        rect.set({
                            left: Math.min(startX, pointer.x),
                            top: Math.min(startY, pointer.y),
                            width,
                            height,
                        });
                        canvas.renderAll();
                    }
                } else if (currentTool === 'circle') {
                    const ellipse = currentShapeRef.current as fabric.Ellipse;
                    if (ellipse) {
                        const rx = Math.abs(pointer.x - startX) / 2;
                        const ry = Math.abs(pointer.y - startY) / 2;
                        ellipse.set({
                            left: (startX + pointer.x) / 2,
                            top: (startY + pointer.y) / 2,
                            rx,
                            ry,
                        });
                        canvas.renderAll();
                    }
                }
            });

            canvas.on('mouse:up', (e) => {
                if (!isDrawingRef.current || !drawStartRef.current) return;

                // Read from refs to get latest settings and tool
                const currentSettings = toolSettingsRef.current;
                const currentTool = activeToolRef.current;

                const pointer = canvas.getViewportPoint(e.e);
                const { x: startX, y: startY } = drawStartRef.current;

                if (currentTool === 'arrow') {
                    // Create arrow on mouse up
                    const arrow = new FabricArrow(
                        [startX, startY, pointer.x, pointer.y],
                        { stroke: currentSettings.color, strokeWidth: currentSettings.strokeWidth }
                    );
                    canvas.add(arrow);
                } else if (currentTool === 'blur' && currentShapeRef.current) {
                    // Replace preview rect with actual blur
                    const rect = currentShapeRef.current as fabric.Rect;
                    const left = rect.left || 0;
                    const top = rect.top || 0;
                    const width = rect.width || 0;
                    const height = rect.height || 0;

                    if (width > 10 && height > 10) {
                        canvas.remove(rect);

                        // Get the source image
                        const container = canvasContainerRef.current;
                        const img = container?.querySelector('img');

                        if (img) {
                            const canvasWidth = canvas.getWidth();
                            const canvasHeight = canvas.getHeight();
                            const blurGroup = createPixelatedRect(left, top, width, height, img, canvasWidth, canvasHeight);
                            canvas.add(blurGroup);
                        }
                    } else {
                        // Remove if too small
                        canvas.remove(rect);
                    }
                }

                isDrawingRef.current = false;
                drawStartRef.current = null;
                currentShapeRef.current = null;
                canvas.selection = true;
            });
        }
    };

    // ========================================================================
    // Actions
    // ========================================================================

    const handleDeleteSelected = () => {
        const canvas = fabricCanvasRef.current;
        if (!canvas) return;

        const activeObjects = canvas.getActiveObjects();
        activeObjects.forEach(obj => canvas.remove(obj));
        canvas.discardActiveObject();
        canvas.renderAll();
    };

    const handleClearAnnotations = () => {
        const canvas = fabricCanvasRef.current;
        if (!canvas) return;

        canvas.clear();
        canvas.renderAll();
    };

    const handleResetAll = () => {
        setWorkingImageSrc(imageSrc);
        setCropApplied(false);
        setMode('crop');
        setCrop(undefined);
        setCompletedCrop(undefined);
        if (fabricCanvasRef.current) {
            fabricCanvasRef.current.clear();
        }
    };

    const handleSave = async () => {
        const canvas = fabricCanvasRef.current;
        const hasAnnotations = canvas && canvas.getObjects().length > 0;

        // If in crop mode with a pending crop selection, apply it first
        if (mode === 'crop' && completedCrop && imgRef.current) {
            const image = imgRef.current;
            const outputCanvas = document.createElement('canvas');
            const ctx = outputCanvas.getContext('2d');
            if (!ctx) return;

            const scaleX = image.naturalWidth / image.width;
            const scaleY = image.naturalHeight / image.height;

            outputCanvas.width = completedCrop.width * scaleX;
            outputCanvas.height = completedCrop.height * scaleY;

            ctx.drawImage(
                image,
                completedCrop.x * scaleX,
                completedCrop.y * scaleY,
                completedCrop.width * scaleX,
                completedCrop.height * scaleY,
                0,
                0,
                outputCanvas.width,
                outputCanvas.height
            );

            const dataUrl = outputCanvas.toDataURL('image/jpeg', 0.9);
            const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
            onSave(base64);
            return;
        }

        // If there are annotations, flatten them onto the image
        if (hasAnnotations) {
            // We need to get the image - either from annotate container or load from workingImageSrc
            const container = canvasContainerRef.current;
            let img = container?.querySelector('img') as HTMLImageElement | null;

            // If not in annotate mode, load the image from workingImageSrc
            if (!img) {
                img = new Image();
                img.crossOrigin = 'anonymous';
                await new Promise<void>((resolve) => {
                    img!.onload = () => resolve();
                    img!.src = workingImageSrc;
                });
            }

            const outputCanvas = document.createElement('canvas');
            const ctx = outputCanvas.getContext('2d');
            if (!ctx) return;

            // Use natural image dimensions for full quality
            outputCanvas.width = img.naturalWidth;
            outputCanvas.height = img.naturalHeight;

            // Draw the base image
            ctx.drawImage(img, 0, 0, outputCanvas.width, outputCanvas.height);

            // Export fabric canvas and draw scaled onto output
            const fabricDataUrl = canvas!.toDataURL({
                format: 'png',
                multiplier: 1,
            });

            const fabricImg = new Image();
            fabricImg.onload = () => {
                ctx.drawImage(
                    fabricImg,
                    0, 0, fabricImg.width, fabricImg.height,
                    0, 0, outputCanvas.width, outputCanvas.height
                );

                const dataUrl = outputCanvas.toDataURL('image/jpeg', 0.9);
                const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
                onSave(base64);
            };
            fabricImg.src = fabricDataUrl;
            return;
        }

        // Save working image as-is (cropped image without annotations, or original)
        if (workingImageSrc.startsWith('data:')) {
            const base64 = workingImageSrc.replace(/^data:image\/\w+;base64,/, '');
            onSave(base64);
        } else {
            // Convert original image to base64
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                const outputCanvas = document.createElement('canvas');
                outputCanvas.width = img.naturalWidth;
                outputCanvas.height = img.naturalHeight;
                const ctx = outputCanvas.getContext('2d');
                if (ctx) {
                    ctx.drawImage(img, 0, 0);
                    const dataUrl = outputCanvas.toDataURL('image/jpeg', 0.9);
                    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
                    onSave(base64);
                }
            };
            img.src = workingImageSrc;
        }
    };

    // ========================================================================
    // Render
    // ========================================================================

    return createPortal(
        <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
            onClick={onCancel}
        >
            <div
                className="glass-surface-2 rounded-2xl shadow-2xl max-w-[95vw] w-full max-h-[95vh] flex flex-col"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-white/10 bg-[#161316]/90 rounded-t-2xl">
                    <h3 className="text-lg font-semibold text-white">Edit Screenshot</h3>
                    <Tooltip content="Close editor">
                        <button
                            onClick={onCancel}
                            className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-white"
                        >
                            <X size={20} />
                        </button>
                    </Tooltip>
                </div>

                {/* Toolbar */}
                <div className="flex items-center gap-1 px-4 py-2 border-b border-white/10 bg-[#1a1a1a] overflow-x-auto">
                    {/* Mode Selection */}
                    <div className="flex items-center gap-1 pr-3 border-r border-white/10">
                        <ToolbarButton
                            icon={<CropIcon size={20} />}
                            label="Crop"
                            active={mode === 'crop'}
                            onClick={() => setMode('crop')}
                        />
                        <ToolbarButton
                            icon={<MousePointer2 size={20} />}
                            label="Annotate"
                            active={mode === 'annotate'}
                            onClick={() => {
                                // Switch directly to annotate mode without requiring crop
                                setMode('annotate');
                            }}
                        />
                    </div>

                    {/* Annotation Tools (only show in annotate mode) */}
                    {mode === 'annotate' && (
                        <>
                            <div className="flex items-center gap-1 px-3 border-r border-white/10">
                                <ToolbarButton
                                    icon={<Pointer size={20} />}
                                    label="Select"
                                    active={activeTool === 'select'}
                                    onClick={() => setActiveTool('select')}
                                />
                                <ToolbarButton
                                    icon={<MoveRight size={20} />}
                                    label="Arrow"
                                    active={activeTool === 'arrow'}
                                    onClick={() => setActiveTool('arrow')}
                                />
                                <ToolbarButton
                                    icon={<Square size={20} />}
                                    label="Box"
                                    active={activeTool === 'rect'}
                                    onClick={() => setActiveTool('rect')}
                                />
                                <ToolbarButton
                                    icon={<Circle size={20} />}
                                    label="Circle"
                                    active={activeTool === 'circle'}
                                    onClick={() => setActiveTool('circle')}
                                />
                                <ToolbarButton
                                    icon={<Type size={20} />}
                                    label="Text"
                                    active={activeTool === 'text'}
                                    onClick={() => setActiveTool('text')}
                                />
                                <ToolbarButton
                                    icon={<Pencil size={20} />}
                                    label="Draw"
                                    active={activeTool === 'freehand'}
                                    onClick={() => setActiveTool('freehand')}
                                />
                                <ToolbarButton
                                    icon={<EyeOff size={20} />}
                                    label="Blur"
                                    active={activeTool === 'blur'}
                                    onClick={() => setActiveTool('blur')}
                                />
                            </div>

                            {/* Tool Settings */}
                            <div className="flex items-center gap-1 px-3 border-r border-white/10">
                                <ColorPicker
                                    currentColor={toolSettings.color}
                                    onColorChange={(color) => setToolSettings(prev => ({ ...prev, color }))}
                                />
                                <StrokeWidthPicker
                                    currentWidth={toolSettings.strokeWidth}
                                    onWidthChange={(strokeWidth) => setToolSettings(prev => ({ ...prev, strokeWidth }))}
                                />
                            </div>

                            {/* Actions */}
                            <div className="flex items-center gap-1 px-3">
                                <ToolbarButton
                                    icon={<Trash2 size={20} />}
                                    label="Delete"
                                    onClick={handleDeleteSelected}
                                />
                            </div>
                        </>
                    )}
                </div>

                {/* Canvas Area */}
                <div className="flex-1 overflow-auto p-4 flex items-center justify-center bg-[#161316] min-h-0">
                    {mode === 'crop' ? (
                        <ReactCrop
                            crop={crop}
                            onChange={(_, percentCrop) => setCrop(percentCrop)}
                            onComplete={(c) => setCompletedCrop(c)}
                            className="max-h-full"
                        >
                            <img
                                ref={imgRef}
                                src={workingImageSrc}
                                alt="Crop preview"
                                onLoad={onImageLoad}
                                crossOrigin="anonymous"
                                className="max-h-[70vh] max-w-full object-contain"
                            />
                        </ReactCrop>
                    ) : (
                        <div
                            ref={canvasContainerRef}
                            className="relative inline-block touch-none"
                        >
                            <img
                                src={workingImageSrc}
                                alt="Annotate preview"
                                crossOrigin="anonymous"
                                className="max-h-[70vh] max-w-full block pointer-events-none select-none"
                            />
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between p-4 border-t border-white/10 bg-[#161316]/90 rounded-b-2xl">
                    <div className="flex items-center gap-2">
                        {mode === 'crop' ? (
                            <>
                                {cropApplied && (
                                    <button
                                        onClick={revertCrop}
                                        className="flex items-center gap-2 px-3 py-2 text-sm bg-amber-600/20 hover:bg-amber-600/30 border border-amber-500/30 rounded-lg transition-colors text-amber-200 font-medium"
                                    >
                                        <RotateCcw size={16} />
                                        Revert Crop
                                    </button>
                                )}
                                <button
                                    onClick={handleResetCrop}
                                    className="flex items-center gap-2 px-3 py-2 text-sm bg-white/10 hover:bg-white/15 rounded-lg transition-colors text-white font-medium"
                                >
                                    <RotateCcw size={16} />
                                    {cropApplied ? 'Reset Selection' : 'Reset Crop'}
                                </button>
                            </>
                        ) : (
                            <>
                                {cropApplied && (
                                    <button
                                        onClick={revertCrop}
                                        className="flex items-center gap-2 px-3 py-2 text-sm bg-amber-600/20 hover:bg-amber-600/30 border border-amber-500/30 rounded-lg transition-colors text-amber-200 font-medium"
                                    >
                                        <RotateCcw size={16} />
                                        Revert Crop
                                    </button>
                                )}
                                <button
                                    onClick={handleClearAnnotations}
                                    className="flex items-center gap-2 px-3 py-2 text-sm bg-white/10 hover:bg-white/15 rounded-lg transition-colors text-white font-medium"
                                >
                                    <RotateCcw size={16} />
                                    Clear Annotations
                                </button>
                                <button
                                    onClick={handleResetAll}
                                    className="flex items-center gap-2 px-3 py-2 text-sm bg-white/10 hover:bg-white/15 rounded-lg transition-colors text-white font-medium"
                                >
                                    <RotateCcw size={16} />
                                    Reset All
                                </button>
                            </>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={onCancel}
                            className="px-4 py-2 text-sm bg-white/15 hover:bg-white/25 rounded-lg transition-colors text-white font-medium"
                        >
                            Cancel
                        </button>
                        {mode === 'crop' && completedCrop && (
                            <button
                                onClick={applyCrop}
                                className="flex items-center gap-2 px-4 py-2 text-sm bg-white/15 hover:bg-white/25 rounded-lg transition-colors text-white font-medium"
                            >
                                <CropIcon size={16} />
                                Apply Crop
                            </button>
                        )}
                        <button
                            onClick={handleSave}
                            className="flex items-center gap-2 px-4 py-2 text-sm bg-[#2721E8] hover:bg-[#4a45f5] rounded-lg transition-colors text-white font-medium"
                        >
                            <Check size={16} />
                            Save
                        </button>
                    </div>
                </div>
            </div>
        </div>,
        document.body
    );
}
