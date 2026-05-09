// Renders the head of the structured-input queue. Each question becomes a
// labeled field; multi-option questions are radios (selectionLimit = 1) or
// checkboxes (selectionLimit > 1 or undefined). Free-text questions render
// as <input type="password"> when isSecret is true so reasoning prompts don't
// leak into the browser's autocomplete history.

import { useMemo, useState } from "react";
import {
  type StructuredInputAnswer,
  type StructuredInputPrompt,
  useStructuredInputStore,
} from "../../state/structured-input-store";
import { Sheet } from "../shared/Sheet";

export function StructuredInputModal() {
  const queue = useStructuredInputStore((state) => state.queue);
  const submit = useStructuredInputStore((state) => state.submit);
  const cancel = useStructuredInputStore((state) => state.cancel);
  const head = queue[0];
  if (!head) return null;
  return <PromptForm prompt={head} onSubmit={submit} onCancel={cancel} />;
}

interface PromptFormProps {
  prompt: StructuredInputPrompt;
  onSubmit(promptId: string, answers: StructuredInputAnswer[]): void;
  onCancel(promptId: string): void;
}

function PromptForm({ prompt, onSubmit, onCancel }: PromptFormProps) {
  const initialAnswers = useMemo(
    () => Object.fromEntries(prompt.questions.map((q) => [q.id, [] as string[]])),
    [prompt.questions]
  );
  const [answers, setAnswers] = useState<Record<string, string[]>>(initialAnswers);

  const update = (questionId: string, values: string[]) =>
    setAnswers((current) => ({ ...current, [questionId]: values }));

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    onSubmit(
      prompt.id,
      prompt.questions.map((question) => ({
        questionId: question.id,
        values: answers[question.id] ?? [],
      }))
    );
  };

  return (
    <Sheet open onClose={() => onCancel(prompt.id)} ariaLabel="Agent input requested">
      <form onSubmit={handleSubmit}>
        <header className="agnt-modal-header">
          <span className="agnt-row-tag">Agent question</span>
          <h2>{prompt.questions.length === 1 ? prompt.questions[0].header ?? "Input requested" : "Input requested"}</h2>
        </header>
        <section className="agnt-modal-body">
          {prompt.questions.map((question) => {
            const value = answers[question.id] ?? [];
            const selectionLimit = question.selectionLimit;
            const allowMultiple = selectionLimit === undefined || selectionLimit > 1;
            return (
              <fieldset key={question.id} className="agnt-input-field">
                <legend>
                  {question.header && <span className="agnt-input-field-header">{question.header}</span>}
                  <span>{question.question}</span>
                </legend>
                {question.options.length === 0 ? (
                  <input
                    type={question.isSecret ? "password" : "text"}
                    className="agnt-input-text"
                    autoComplete={question.isSecret ? "off" : "on"}
                    value={value[0] ?? ""}
                    onChange={(event) => update(question.id, event.target.value ? [event.target.value] : [])}
                  />
                ) : (
                  <div className="agnt-input-options">
                    {question.options.map((option) => {
                      const checked = value.includes(option.label);
                      return (
                        <label key={option.label} className="agnt-input-option">
                          <input
                            type={allowMultiple ? "checkbox" : "radio"}
                            name={question.id}
                            checked={checked}
                            onChange={(event) =>
                              update(
                                question.id,
                                allowMultiple
                                  ? event.target.checked
                                    ? [...value, option.label]
                                    : value.filter((label) => label !== option.label)
                                  : event.target.checked
                                    ? [option.label]
                                    : []
                              )
                            }
                          />
                          <span>
                            <strong>{option.label}</strong>
                            {option.description && <span className="agnt-input-option-desc">{option.description}</span>}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </fieldset>
            );
          })}
        </section>
        <footer className="agnt-modal-footer">
          <button type="button" className="agnt-button-ghost" onClick={() => onCancel(prompt.id)}>
            Cancel
          </button>
          <button type="submit" className="agnt-button-primary">
            Submit
          </button>
        </footer>
      </form>
    </Sheet>
  );
}
