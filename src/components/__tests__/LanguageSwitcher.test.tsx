import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useTranslation } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";

import "@/test/i18n";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { i18n } from "@/i18n/config";

function Sample() {
  const { t } = useTranslation("vendorConsole");
  return <p>{t("customers.listTitle")}</p>;
}

describe("LanguageSwitcher", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
  });

  it("switches the whole console to French and remembers the choice in this browser", async () => {
    render(
      <>
        <LanguageSwitcher />
        <Sample />
      </>,
    );
    expect(screen.getByText("Customer list")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Language"), "fr");
    expect(await screen.findByText("Liste des clients")).toBeInTheDocument();
    expect(screen.getByLabelText("Langue")).toHaveValue("fr");
    expect(document.documentElement.lang).toBe("fr");
    expect(window.localStorage.getItem("maintafox.console.language")).toBe("fr");
  });
});
