"use client";

import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { Children, isValidElement, useEffect, useId, useRef, useState, type ReactNode, type SelectHTMLAttributes } from "react";
import styles from "./select.module.css";

type Option = { value: string; label: ReactNode; disabled: boolean };
function text(node: ReactNode): string {
  return Children.toArray(node).map((child) => isValidElement<{ children?: ReactNode }>(child) ? text(child.props.children) : String(child)).join("");
}
function options(children: ReactNode, disabled = false): Option[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<{ children?: ReactNode; value?: string | number; disabled?: boolean }>(child)) return [];
    if (child.type === "option") return [{ value: String(child.props.value ?? text(child.props.children)), label: child.props.children, disabled: disabled || Boolean(child.props.disabled) }];
    return options(child.props.children, disabled || Boolean(child.props.disabled));
  });
}

/** Native option/prop adapter: existing handlers receive a real select change
 * event, and the hidden native control retains submission and validation. */
export function Select({ children, value, defaultValue, onChange, className, id, name, required, disabled, form, autoComplete, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const items = options(children);
  const initialValue = String(defaultValue ?? items.find((item) => !item.disabled)?.value ?? "");
  const [uncontrolledValue, setUncontrolledValue] = useState(initialValue);
  const currentValue = value === undefined ? uncontrolledValue : String(value);
  const emptyValue = useId();
  const generatedId = useId();
  const triggerId = id ?? generatedId;
  const native = useRef<HTMLSelectElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = items.find((item) => item.value === currentValue);

  useEffect(() => {
    const owner = native.current?.form;
    const reset = (event: Event) => queueMicrotask(() => {
      if (event.defaultPrevented) return;
      setUncontrolledValue(initialValue);
      if (native.current) native.current.value = value === undefined ? initialValue : String(value);
    });
    owner?.addEventListener("reset", reset);
    return () => owner?.removeEventListener("reset", reset);
  }, [initialValue, value]);

  function change(nextValue: string) {
    const control = native.current;
    if (!control) return;
    control.value = nextValue === emptyValue ? "" : nextValue;
    control.dispatchEvent(new Event("change", { bubbles: true }));
  }

  return <span className={styles.wrapper} onChangeCapture={(event) => {
    // Only the original named field participates in form change handling.
    // Radix's unnamed mirror otherwise emits a second bubbling change.
    if (event.target instanceof HTMLSelectElement && event.target !== native.current) event.stopPropagation();
  }}>
    <RadixSelect.Root value={currentValue === "" ? emptyValue : currentValue} onValueChange={change} disabled={disabled}>
      <RadixSelect.Trigger
        ref={trigger}
        id={triggerId}
        className={`${styles.trigger}${className ? ` ${className}` : ""}`}
        aria-label={props["aria-label"]}
        aria-labelledby={props["aria-labelledby"]}
        aria-describedby={props["aria-describedby"]}
        aria-invalid={props["aria-invalid"]}
        aria-required={required || undefined}
        title={props.title}
        tabIndex={props.tabIndex}
        dir={props.dir}
        style={props.style}
        data-value={currentValue}
      >
        <RadixSelect.Value className={styles.value}>{selected?.label}</RadixSelect.Value>
        <RadixSelect.Icon className={styles.icon}><ChevronDown size={16} aria-hidden /></RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content className={styles.content} aria-labelledby={triggerId} position="popper" sideOffset={6} collisionPadding={12}>
          <RadixSelect.ScrollUpButton className={styles.scroll}><ChevronUp size={16} aria-hidden /></RadixSelect.ScrollUpButton>
          <RadixSelect.Viewport className={styles.viewport}>
            {items.map((item) => <RadixSelect.Item className={styles.item} key={item.value} data-value={item.value} value={item.value === "" ? emptyValue : item.value} disabled={item.disabled} textValue={text(item.label)}>
              <RadixSelect.ItemText>{item.label}</RadixSelect.ItemText>
              <RadixSelect.ItemIndicator className={styles.indicator}><Check size={16} aria-hidden /></RadixSelect.ItemIndicator>
            </RadixSelect.Item>)}
          </RadixSelect.Viewport>
          <RadixSelect.ScrollDownButton className={styles.scroll}><ChevronDown size={16} aria-hidden /></RadixSelect.ScrollDownButton>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
    <select
      {...props}
      ref={native}
      className={styles.native}
      aria-label={undefined}
      aria-labelledby={undefined}
      aria-describedby={undefined}
      aria-hidden="true"
      tabIndex={-1}
      name={name}
      required={required}
      disabled={disabled}
      form={form}
      autoComplete={autoComplete}
      value={currentValue}
      onInvalid={(event) => { event.preventDefault(); trigger.current?.focus(); props.onInvalid?.(event); }}
      onChange={(event) => { setUncontrolledValue(event.target.value); onChange?.(event); }}
    >{children}</select>
  </span>;
}
