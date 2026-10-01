import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CreditCard, RefreshCw } from "lucide-react";
import type { SourceView, SyncOptions, SyncPlan } from "../shared/model";
import { api } from "./api";
import { Busy, Button, Field, Modal } from "./components";

export function SyncConfirmation({
  source,
  busy,
  onClose,
  onConfirm,
}: {
  source: SourceView;
  busy: boolean;
  onClose: () => void;
  onConfirm: (options: SyncOptions) => void;
}) {
  const [options, setOptions] = useState<Partial<SyncOptions>>({});
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [needsExactPlan, setNeedsExactPlan] = useState(false);
  const isAllEvents = source.providerId === "allevents";
  const isTelegram = source.providerId === "telegram";

  useEffect(() => {
    let active = true;
    setPlan(null);
    setOptions({});
    setNeedsExactPlan(false);
    setLoading(true);
    setError("");
    void api<SyncPlan>(`/sources/${source.id}/sync-plan`, "POST", {})
      .then((next) => {
        if (!active) return;
        setPlan(next);
        setOptions({
          startDate: next.startDate,
          endDate: next.endDate,
          categories: next.categories,
          resultsPerQuery: next.resultsPerQuery,
          maxItems: next.paid?.maxItems || next.limits?.maxItems,
          operations: next.operations,
          previewId: next.previewId,
        });
      })
      .catch((caught) => {
        if (active)
          setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [source.id]);

  const refreshPlan = async () => {
    setLoading(true);
    setError("");
    try {
      const requested = { ...options, previewId: undefined, confirmed: false };
      const next = await api<SyncPlan>(
        `/sources/${source.id}/sync-plan`,
        "POST",
        requested,
      );
      setPlan(next);
      setOptions((current) => ({
        ...current,
        startDate: next.startDate,
        endDate: next.endDate,
        categories: next.categories,
        resultsPerQuery: next.resultsPerQuery || current.resultsPerQuery,
        maxItems:
          current.maxItems && next.paid
            ? Math.min(current.maxItems, next.paid.maxItems)
            : current.maxItems || next.paid?.maxItems || next.limits?.maxItems,
        operations: current.operations || next.operations,
        previewId: next.previewId,
      }));
      setNeedsExactPlan(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  const paidEstimate = useMemo(() => {
    if (!plan?.paid || !options.maxItems) return plan?.paid?.maxChargeUsd;
    const rate = plan.paid.maxChargeUsd / plan.paid.maxItems;
    return Math.ceil(rate * options.maxItems * 100) / 100;
  }, [plan, options.maxItems]);
  const set = <K extends keyof SyncOptions>(key: K, value: SyncOptions[K]) => {
    const invalidatesPlan =
      (isAllEvents && ["startDate", "endDate", "categories"].includes(key)) ||
      (isTelegram && key === "operations");
    setOptions((current) => ({
      ...current,
      [key]: value,
      ...(invalidatesPlan ? { previewId: undefined } : {}),
    }));
    if (invalidatesPlan) setNeedsExactPlan(true);
  };

  return (
    <Modal
      title={plan?.title || `Параметры · ${source.name}`}
      onClose={onClose}
      wide
    >
      <div className="sync-confirmation">
        {loading && !plan ? (
          <div className="sync-plan-loading">
            <Busy />
            {isAllEvents
              ? "Читаю страницы AllEvents для точного плана…"
              : "Рассчитываю параметры…"}
          </div>
        ) : !plan && error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : plan ? (
          <>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <p className="sync-plan-summary">{plan.summary}</p>
            {plan.startDate && (
              <div className="form-grid sync-plan-controls">
                <Field
                  label={isTelegram ? "Публикации с даты" : "С даты · now"}
                >
                  <input
                    type="date"
                    value={options.startDate || plan.startDate}
                    onChange={(event) => set("startDate", event.target.value)}
                  />
                </Field>
                <Field
                  label={
                    isTelegram ? "Публикации по дату" : "По дату · включительно"
                  }
                >
                  <input
                    type="date"
                    value={options.endDate || plan.endDate}
                    onChange={(event) => set("endDate", event.target.value)}
                  />
                </Field>
              </div>
            )}
            {plan.categoryOptions && (
              <fieldset className="sync-categories">
                <legend>Типы событий</legend>
                <div>
                  {plan.categoryOptions.map((category) => {
                    const selected =
                      options.categories || plan.categories || [];
                    const checked = selected.includes(category.value);
                    return (
                      <label className="checkbox" key={category.value}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            let next = checked
                              ? selected.filter(
                                  (item) => item !== category.value,
                                )
                              : [...selected, category.value];
                            if (category.value === "all" && !checked)
                              next = ["all"];
                            else if (category.value !== "all")
                              next = next.filter((item) => item !== "all");
                            if (!next.length) next = ["all"];
                            set("categories", next);
                          }}
                        />
                        {category.label}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            )}
            {plan.operationOptions && (
              <fieldset className="sync-categories">
                <legend>MTProto-операции</legend>
                <div>
                  {plan.operationOptions.map((operation) => {
                    const selected =
                      options.operations || plan.operations || [];
                    const checked = selected.includes(operation.value);
                    return (
                      <label className="checkbox" key={operation.value}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            const next = checked
                              ? selected.filter(
                                  (item) => item !== operation.value,
                                )
                              : [...selected, operation.value];
                            if (next.length) set("operations", next);
                          }}
                        />
                        {operation.label}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            )}
            {(plan.paid || plan.limits) && (
              <div className="form-grid sync-plan-controls">
                <Field label="Максимум на гипотезу">
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={options.resultsPerQuery || plan.resultsPerQuery || 1}
                    onChange={(event) =>
                      set("resultsPerQuery", Number(event.target.value))
                    }
                  />
                </Field>
                <Field label="Общий hard cap результатов">
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={
                      options.maxItems ||
                      plan.paid?.maxItems ||
                      plan.limits?.maxItems ||
                      100
                    }
                    onChange={(event) =>
                      set("maxItems", Number(event.target.value))
                    }
                  />
                </Field>
              </div>
            )}
            <dl className="sync-plan-parameters">
              {plan.parameters.map((parameter) => (
                <div key={parameter.label}>
                  <dt>{parameter.label}</dt>
                  <dd>{parameter.value}</dd>
                </div>
              ))}
              {plan.previewRequests === undefined && (
                <div>
                  <dt>Оценка запросов</dt>
                  <dd>
                    {plan.expectedRequests ??
                      `${plan.minimumRequests}–${plan.maximumRequests}`}
                    {loading && <RefreshCw size={12} className="spin" />}
                  </dd>
                </div>
              )}
              {plan.knownItems !== undefined && (
                <div>
                  <dt>Уже в raw-базе</dt>
                  <dd>{plan.knownItems}</dd>
                </div>
              )}
              {plan.paid && (
                <div className="paid-total">
                  <dt>
                    <CreditCard size={14} /> Максимальная оценка
                  </dt>
                  <dd>${(paidEstimate || 0).toFixed(2)}</dd>
                </div>
              )}
            </dl>
            <div className="sync-plan-warnings">
              {needsExactPlan && (
                <p>
                  <AlertTriangle size={14} />
                  Фильтры изменены: пересчитайте точное число страниц перед
                  запуском.
                </p>
              )}
              {plan.warnings.map((warning) => (
                <p key={warning}>
                  <AlertTriangle size={14} />
                  {warning}
                </p>
              ))}
            </div>
          </>
        ) : null}
      </div>
      <footer className="dialog-footer">
        {(isAllEvents || isTelegram) && plan && (
          <Button
            onClick={() => void refreshPlan()}
            disabled={loading || busy || !needsExactPlan}
          >
            {loading && <Busy />}
            Пересчитать план
          </Button>
        )}
        <Button onClick={onClose}>Отмена</Button>
        <Button
          primary
          disabled={
            !plan ||
            !!error ||
            loading ||
            busy ||
            ((isAllEvents || isTelegram) && needsExactPlan)
          }
          onClick={() =>
            onConfirm({ ...options, confirmed: true } as SyncOptions)
          }
        >
          {busy && <Busy />}
          {plan?.paid
            ? "Подтвердить платный запуск"
            : isTelegram
              ? "Начать Telegram-поиск"
              : "Начать синхронизацию"}
        </Button>
      </footer>
    </Modal>
  );
}
