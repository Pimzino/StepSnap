// Cross-platform accessibility API for getting UI element info at coordinates

#[derive(Clone, serde::Serialize, Debug)]
pub struct ElementInfo {
    pub name: String,
    pub element_type: String,
    pub value: Option<String>,
    pub app_name: Option<String>,
}

impl Default for ElementInfo {
    fn default() -> Self {
        Self {
            name: String::new(),
            element_type: String::new(),
            value: None,
            app_name: None,
        }
    }
}

/// Read the value of the currently focused input field via the platform's
/// accessibility API. Used by the recorder to capture the FINAL state of a text
/// field after typing (autocomplete-accepted, pasted, IME-composed, or edited
/// text), which is more reliable than the raw keystroke stream.
///
/// `source` records which AX surface produced the value, for diagnostics.
/// `is_password` is true when the focused element is a password/secure field;
/// in that case `value` will be the literal sentinel `"[password]"` and callers
/// MUST NOT log or persist the actual content.
#[derive(Clone, Debug)]
pub struct FocusedFieldValue {
    pub value: String,
    pub source: &'static str,
    pub is_password: bool,
}

/// Cap large field values so a multi-line editor dump doesn't blow up our
/// payloads. Keeps the first and last segments so URLs/codes near the ends
/// are preserved.
fn cap_value(s: String, max_len: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max_len {
        return s;
    }
    let head_len = max_len / 2;
    let tail_len = max_len.saturating_sub(head_len).saturating_sub(1);
    let head: String = chars[..head_len].iter().collect();
    let tail: String = chars[chars.len() - tail_len..].iter().collect();
    format!("{}…{}", head, tail)
}

const MAX_FIELD_VALUE_CHARS: usize = 2000;

// Windows implementation using UI Automation
#[cfg(target_os = "windows")]
pub fn get_element_at_point(x: f64, y: f64) -> Option<ElementInfo> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};

    unsafe {
        // Initialize COM
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        // Create UI Automation instance
        let automation: IUIAutomation =
            match CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) {
                Ok(a) => a,
                Err(_) => return None,
            };

        // Get element at point
        let point = POINT {
            x: x as i32,
            y: y as i32,
        };
        let element = match automation.ElementFromPoint(point) {
            Ok(e) => e,
            Err(_) => return None,
        };

        // Get element properties using direct methods
        let name = element
            .CurrentName()
            .ok()
            .map(|s| s.to_string())
            .unwrap_or_default();

        let element_type = element
            .CurrentLocalizedControlType()
            .ok()
            .map(|s| s.to_string())
            .unwrap_or_default();

        // Value pattern is more complex, skip for now
        let value = None;

        // Try to get app name by walking up to root
        let app_name = if let Ok(walker) = automation.ControlViewWalker() {
            let mut current = element.clone();
            let mut root_name = None;
            for _ in 0..10 {
                if let Ok(parent) = walker.GetParentElement(&current) {
                    if let Ok(n) = parent.CurrentName() {
                        let s = n.to_string();
                        if !s.is_empty() {
                            root_name = Some(s);
                        }
                    }
                    current = parent;
                } else {
                    break;
                }
            }
            root_name
        } else {
            None
        };

        Some(ElementInfo {
            name,
            element_type,
            value,
            app_name,
        })
    }
}

/// Windows implementation of `get_focused_field_value`.
///
/// Uses `IUIAutomation::GetFocusedElement` and tries (in order):
/// 1. `IsPassword` → short-circuit redacted result, never log content.
/// 2. `IUIAutomationValuePattern` (single-line edits)
/// 3. `IUIAutomationTextPattern` (multi-line / rich text editors)
/// 4. `IUIAutomationLegacyIAccessiblePattern` (older / MSAA-bridged controls)
#[cfg(target_os = "windows")]
pub fn get_focused_field_value() -> Option<FocusedFieldValue> {
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationLegacyIAccessiblePattern,
        IUIAutomationTextPattern, IUIAutomationValuePattern, UIA_LegacyIAccessiblePatternId,
        UIA_TextPatternId, UIA_ValuePatternId,
    };

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
        let element = automation.GetFocusedElement().ok()?;

        // Password short-circuit — never read the actual content.
        if element.CurrentIsPassword().ok().map(|b| b.as_bool()).unwrap_or(false) {
            return Some(FocusedFieldValue {
                value: "[password]".into(),
                source: "password",
                is_password: true,
            });
        }

        // ValuePattern — covers single-line edits (most text inputs).
        if let Ok(vp) = element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
        {
            if let Ok(bstr) = vp.CurrentValue() {
                let s = bstr.to_string();
                if !s.is_empty() {
                    return Some(FocusedFieldValue {
                        value: cap_value(s, MAX_FIELD_VALUE_CHARS),
                        source: "ax_value",
                        is_password: false,
                    });
                }
            }
        }

        // TextPattern — covers multi-line / rich edits where ValuePattern is not implemented.
        if let Ok(tp) = element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
        {
            if let Ok(range) = tp.DocumentRange() {
                if let Ok(bstr) = range.GetText(-1) {
                    let s = bstr.to_string();
                    if !s.is_empty() {
                        return Some(FocusedFieldValue {
                            value: cap_value(s, MAX_FIELD_VALUE_CHARS),
                            source: "ax_text",
                            is_password: false,
                        });
                    }
                }
            }
        }

        // LegacyIAccessiblePattern — older controls bridged through MSAA.
        if let Ok(legacy) = element
            .GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(
                UIA_LegacyIAccessiblePatternId,
            )
        {
            if let Ok(bstr) = legacy.CurrentValue() {
                let s = bstr.to_string();
                if !s.is_empty() {
                    return Some(FocusedFieldValue {
                        value: cap_value(s, MAX_FIELD_VALUE_CHARS),
                        source: "ax_legacy",
                        is_password: false,
                    });
                }
            }
        }

        None
    }
}

// macOS implementation using Accessibility API
#[cfg(target_os = "macos")]
pub fn get_element_at_point(x: f64, y: f64) -> Option<ElementInfo> {
    use core_foundation::base::{CFRelease, CFTypeRef, TCFType};
    use core_foundation::string::{CFString, CFStringRef};
    use std::ptr;

    // AX error code for success
    const K_AX_ERROR_SUCCESS: i32 = 0;

    // Attribute name constants
    fn cf_string(s: &str) -> CFString {
        CFString::new(s)
    }

    unsafe {
        #[link(name = "ApplicationServices", kind = "framework")]
        extern "C" {
            fn AXUIElementCreateSystemWide() -> *mut std::ffi::c_void;
            fn AXUIElementCopyElementAtPosition(
                element: *mut std::ffi::c_void,
                x: f32,
                y: f32,
                element_at_position: *mut *mut std::ffi::c_void,
            ) -> i32;
            fn AXUIElementCopyAttributeValue(
                element: *mut std::ffi::c_void,
                attribute: CFStringRef,
                value: *mut CFTypeRef,
            ) -> i32;
        }

        let system_wide = AXUIElementCreateSystemWide();
        if system_wide.is_null() {
            return None;
        }

        let mut element_at_pos: *mut std::ffi::c_void = ptr::null_mut();
        let result =
            AXUIElementCopyElementAtPosition(system_wide, x as f32, y as f32, &mut element_at_pos);

        CFRelease(system_wide as *const _);

        if result != K_AX_ERROR_SUCCESS || element_at_pos.is_null() {
            return None;
        }

        // Helper to get string attribute from an AX element
        let get_string_attr = |element: *mut std::ffi::c_void, attr_name: &str| -> Option<String> {
            let attr = cf_string(attr_name);
            let mut value: CFTypeRef = ptr::null();
            let result =
                AXUIElementCopyAttributeValue(element, attr.as_concrete_TypeRef(), &mut value);
            if result == K_AX_ERROR_SUCCESS && !value.is_null() {
                // Try to interpret as CFString
                let cf_str = CFString::wrap_under_create_rule(value as CFStringRef);
                Some(cf_str.to_string())
            } else {
                None
            }
        };

        // Get title (name) - try multiple attributes
        let name = get_string_attr(element_at_pos, "AXTitle")
            .or_else(|| get_string_attr(element_at_pos, "AXDescription"))
            .or_else(|| get_string_attr(element_at_pos, "AXHelp"))
            .unwrap_or_default();

        // Get role (element type)
        let role = get_string_attr(element_at_pos, "AXRole").unwrap_or_default();
        // Convert AX role to human-readable type
        let element_type = match role.as_str() {
            "AXButton" => "Button".to_string(),
            "AXTextField" => "Text Field".to_string(),
            "AXStaticText" => "Text".to_string(),
            "AXLink" => "Link".to_string(),
            "AXCheckBox" => "Checkbox".to_string(),
            "AXRadioButton" => "Radio Button".to_string(),
            "AXPopUpButton" => "Dropdown".to_string(),
            "AXComboBox" => "Combo Box".to_string(),
            "AXSlider" => "Slider".to_string(),
            "AXTabGroup" => "Tab Group".to_string(),
            "AXTab" => "Tab".to_string(),
            "AXTable" => "Table".to_string(),
            "AXRow" => "Row".to_string(),
            "AXCell" => "Cell".to_string(),
            "AXImage" => "Image".to_string(),
            "AXMenu" => "Menu".to_string(),
            "AXMenuItem" => "Menu Item".to_string(),
            "AXMenuBar" => "Menu Bar".to_string(),
            "AXToolbar" => "Toolbar".to_string(),
            "AXWindow" => "Window".to_string(),
            "AXGroup" => "Group".to_string(),
            "AXScrollArea" => "Scroll Area".to_string(),
            "AXList" => "List".to_string(),
            "AXOutline" => "Outline".to_string(),
            "AXTextArea" => "Text Area".to_string(),
            "AXWebArea" => "Web Content".to_string(),
            _ => {
                if role.starts_with("AX") {
                    role[2..].to_string()
                } else {
                    role
                }
            }
        };

        // Get value
        let value = get_string_attr(element_at_pos, "AXValue");

        // Walk up the element tree to find the app name
        let mut app_name: Option<String> = None;
        let mut current_element = element_at_pos;
        for _ in 0..20 {
            // Get parent element
            let attr = cf_string("AXParent");
            let mut parent_value: CFTypeRef = ptr::null();
            let result = AXUIElementCopyAttributeValue(
                current_element,
                attr.as_concrete_TypeRef(),
                &mut parent_value,
            );

            if result != K_AX_ERROR_SUCCESS || parent_value.is_null() {
                break;
            }

            // Check if this element has a title we can use as app name
            if let Some(title) = get_string_attr(parent_value as *mut std::ffi::c_void, "AXTitle") {
                if !title.is_empty() {
                    app_name = Some(title);
                }
            }

            // Also check AXRoleDescription for top-level window/app
            if let Some(role) = get_string_attr(parent_value as *mut std::ffi::c_void, "AXRole") {
                if role == "AXApplication" {
                    // Found the application - get its title
                    if let Some(title) =
                        get_string_attr(parent_value as *mut std::ffi::c_void, "AXTitle")
                    {
                        if !title.is_empty() {
                            app_name = Some(title);
                        }
                    }
                    CFRelease(parent_value);
                    break;
                }
            }

            // Release current element if it's not the original
            if current_element != element_at_pos {
                CFRelease(current_element as *const _);
            }
            current_element = parent_value as *mut std::ffi::c_void;
        }

        // Clean up remaining element references
        if current_element != element_at_pos && !current_element.is_null() {
            CFRelease(current_element as *const _);
        }
        CFRelease(element_at_pos as *const _);

        Some(ElementInfo {
            name,
            element_type,
            value,
            app_name,
        })
    }
}

/// macOS implementation of `get_focused_field_value`.
///
/// Walks: system-wide → focused application → focused UI element, then reads
/// `kAXValueAttribute`. Short-circuits to redacted `"[password]"` for
/// `AXSecureTextField`.
#[cfg(target_os = "macos")]
pub fn get_focused_field_value() -> Option<FocusedFieldValue> {
    use core_foundation::base::{CFRelease, CFTypeRef, TCFType};
    use core_foundation::string::{CFString, CFStringRef};
    use std::ptr;

    const K_AX_ERROR_SUCCESS: i32 = 0;

    fn cf_string(s: &str) -> CFString {
        CFString::new(s)
    }

    unsafe {
        #[link(name = "ApplicationServices", kind = "framework")]
        extern "C" {
            fn AXUIElementCreateSystemWide() -> *mut std::ffi::c_void;
            fn AXUIElementCopyAttributeValue(
                element: *mut std::ffi::c_void,
                attribute: CFStringRef,
                value: *mut CFTypeRef,
            ) -> i32;
        }

        let system_wide = AXUIElementCreateSystemWide();
        if system_wide.is_null() {
            return None;
        }

        // Resolve focused element: system → focused app → focused UI element.
        // We resolve in two steps because the system-wide focused-UI-element
        // attribute returns the focused element across all apps directly.
        let mut focused_element: CFTypeRef = ptr::null();
        let attr = cf_string("AXFocusedUIElement");
        let result = AXUIElementCopyAttributeValue(
            system_wide,
            attr.as_concrete_TypeRef(),
            &mut focused_element,
        );
        CFRelease(system_wide as *const _);

        if result != K_AX_ERROR_SUCCESS || focused_element.is_null() {
            return None;
        }
        let focused = focused_element as *mut std::ffi::c_void;

        let get_string_attr = |element: *mut std::ffi::c_void, attr_name: &str| -> Option<String> {
            let attr = cf_string(attr_name);
            let mut value: CFTypeRef = ptr::null();
            let result =
                AXUIElementCopyAttributeValue(element, attr.as_concrete_TypeRef(), &mut value);
            if result == K_AX_ERROR_SUCCESS && !value.is_null() {
                let cf_str = CFString::wrap_under_create_rule(value as CFStringRef);
                Some(cf_str.to_string())
            } else {
                None
            }
        };

        // Password short-circuit on secure text fields.
        let role = get_string_attr(focused, "AXRole").unwrap_or_default();
        if role == "AXSecureTextField" {
            CFRelease(focused as *const _);
            return Some(FocusedFieldValue {
                value: "[password]".into(),
                source: "password",
                is_password: true,
            });
        }

        // Try AXValue (works for AXTextField, AXTextArea, AXComboBox).
        let value = get_string_attr(focused, "AXValue");
        CFRelease(focused as *const _);

        match value {
            Some(s) if !s.is_empty() => Some(FocusedFieldValue {
                value: cap_value(s, MAX_FIELD_VALUE_CHARS),
                source: "ax_value",
                is_password: false,
            }),
            _ => None,
        }
    }
}

// Linux implementation using AT-SPI
#[cfg(target_os = "linux")]
pub fn get_element_at_point(x: f64, y: f64) -> Option<ElementInfo> {
    // AT-SPI requires async runtime, simplified sync wrapper
    use std::process::Command;

    // Use gdbus or similar to query AT-SPI
    // This is a placeholder - full implementation would use atspi crate
    let output = Command::new("gdbus")
        .args([
            "call",
            "--session",
            "--dest=org.a11y.atspi.Registry",
            "--object-path=/org/a11y/atspi/accessible/root",
            "--method=org.a11y.atspi.Component.GetAccessibleAtPoint",
            &format!("{}", x as i32),
            &format!("{}", y as i32),
            "0", // CoordType: screen
        ])
        .output()
        .ok()?;

    if output.status.success() {
        Some(ElementInfo {
            name: "UI Element".to_string(),
            element_type: "unknown".to_string(),
            value: None,
            app_name: None,
        })
    } else {
        None
    }
}

/// Linux implementation of `get_focused_field_value`.
///
/// Embeds a current-thread tokio runtime, opens an AT-SPI connection, walks
/// the accessibility tree from the registry root looking for an element
/// whose state set includes FOCUSED, and reads its text via the Text
/// interface. On any failure (no bus, no focused element, no text interface,
/// permission denied) returns `None` so the recorder falls back to the raw
/// keystroke buffer.
///
/// Limitations:
/// - Wayland with weak AT-SPI support (sway, river, hyprland without
///   `at-spi-bus-launcher`) will typically fail at the connection stage
///   and fall back gracefully.
/// - GTK / Qt / Electron apps with proper AT-SPI exposure should work.
/// - Tree traversal is bounded (max depth + breadth caps) to avoid pathological
///   apps. Walking the entire tree on every flush would be too slow.
/// - Password fields surface as `password text` role; we detect and redact.
#[cfg(target_os = "linux")]
pub fn get_focused_field_value() -> Option<FocusedFieldValue> {
    use atspi::connection::P2P;
    use atspi::proxy::accessible::AccessibleProxy;
    use atspi::proxy::text::TextProxy;
    use atspi::{AccessibilityConnection, State};

    /// Walk a bounded subtree of the accessibility tree looking for the
    /// element whose state set contains FOCUSED. Returns the first match.
    /// Bounded to avoid pathological wide/deep trees on Linux desktops.
    #[allow(clippy::too_many_arguments)]
    async fn find_focused<'a>(
        node: AccessibleProxy<'a>,
        depth: u32,
        max_depth: u32,
        max_children: u32,
        conn: &'a AccessibilityConnection,
    ) -> Option<AccessibleProxy<'a>> {
        // Check this node's state set.
        if let Ok(states) = node.get_state().await {
            if states.contains(State::Focused) {
                return Some(node);
            }
        }
        if depth >= max_depth {
            return None;
        }
        let children = node.get_children().await.ok()?;
        for (i, child_ref) in children.into_iter().enumerate() {
            if i as u32 >= max_children {
                break;
            }
            let child = match conn.object_as_accessible(&child_ref).await {
                Ok(p) => p,
                Err(_) => continue,
            };
            if let Some(found) = Box::pin(find_focused(
                child,
                depth + 1,
                max_depth,
                max_children,
                conn,
            ))
            .await
            {
                return Some(found);
            }
        }
        None
    }

    async fn run() -> Option<FocusedFieldValue> {
        let conn = AccessibilityConnection::new().await.ok()?;
        let root = conn.root_accessible_on_registry().await.ok()?;
        let focused = find_focused(root, 0, 12, 64, &conn).await?;

        // Password detection by role name. AT-SPI exposes "password text"
        // as the canonical role for secure entry widgets.
        if let Ok(role) = focused.get_role_name().await {
            if role.eq_ignore_ascii_case("password text") {
                return Some(FocusedFieldValue {
                    value: "[password]".into(),
                    source: "password",
                    is_password: true,
                });
            }
        }

        // Read text via the Text interface. The accessible's path/destination
        // is reused to construct a TextProxy.
        let dest = focused.inner().destination();
        let path = focused.inner().path();
        let text_proxy = TextProxy::builder(focused.inner().connection())
            .destination(dest)
            .ok()?
            .path(path)
            .ok()?
            .build()
            .await
            .ok()?;
        let char_count = text_proxy.character_count().await.ok()?;
        if char_count <= 0 {
            return None;
        }
        let text = text_proxy.get_text(0, char_count).await.ok()?;
        if text.is_empty() {
            return None;
        }
        Some(FocusedFieldValue {
            value: cap_value(text, MAX_FIELD_VALUE_CHARS),
            source: "ax_value",
            is_password: false,
        })
    }

    // Embed a current-thread tokio runtime. atspi/zbus require an async
    // executor; the recorder thread is otherwise synchronous so we spin one
    // up per call. Cost is ~1-5ms of overhead per flush, dominated by the
    // bus round-trips that follow.
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(_) => return None,
    };
    runtime.block_on(run())
}

// Fallback for other platforms
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub fn get_element_at_point(_x: f64, _y: f64) -> Option<ElementInfo> {
    None
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub fn get_focused_field_value() -> Option<FocusedFieldValue> {
    None
}
