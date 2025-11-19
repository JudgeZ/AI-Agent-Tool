import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BrowserTool } from "./BrowserTool";
import { ToolContext } from "../McpTool";
import puppeteer, { Browser, Page } from "puppeteer";
import pino from "pino";

vi.mock("puppeteer");

describe("BrowserTool", () => {
  let tool: BrowserTool;
  let mockBrowser: any;
  let mockPage: any;
  let mockContext: ToolContext;
  let mockLogger: pino.Logger;

  beforeEach(async () => {
    mockLogger = pino({ level: "silent" });
    mockContext = {
      requestApproval: vi.fn().mockResolvedValue(true),
      tenantId: "test-tenant",
      userId: "test-user",
      sessionId: "test-session",
    } as any;

    // Create mock page
    mockPage = {
      goto: vi.fn().mockResolvedValue({ status: () => 200 }),
      title: vi.fn().mockResolvedValue("Test Page"),
      url: vi.fn().mockReturnValue("https://example.com"),
      click: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockResolvedValue(undefined),
      waitForSelector: vi.fn().mockResolvedValue(undefined),
      waitForNavigation: vi.fn().mockResolvedValue(undefined),
      waitForXPath: vi.fn().mockResolvedValue(undefined),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-image")),
      $eval: vi.fn().mockResolvedValue("extracted text"),
      $$eval: vi.fn().mockResolvedValue(["text1", "text2"]),
      evaluate: vi.fn().mockResolvedValue({ success: true }),
      select: vi.fn().mockResolvedValue(undefined),
      keyboard: { press: vi.fn() } as any,
      setViewport: vi.fn().mockResolvedValue(undefined),
      setUserAgent: vi.fn().mockResolvedValue(undefined),
      setDefaultTimeout: vi.fn(),
      setRequestInterception: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    } as any;

    // Create mock browser
    mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      close: vi.fn().mockResolvedValue(undefined),
      version: vi.fn().mockResolvedValue("Chrome/120.0.0"),
    } as any;

    (puppeteer.launch as any).mockResolvedValue(mockBrowser);

    tool = new BrowserTool(mockLogger, {
      headless: true,
      defaultTimeout: 30000,
      maxPages: 5,
    });

    await tool.initialize();
  });

  afterEach(async () => {
    await tool.shutdown();
    vi.clearAllMocks();
  });

  describe("navigate", () => {
    it("should navigate to URL successfully", async () => {
      const result = await tool.execute(
        {
          operation: "navigate",
          params: { url: "https://example.com" },
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.data.url).toBe("https://example.com");
      expect(result.data.statusCode).toBe(200);
      expect(mockPage.goto).toHaveBeenCalledWith(
        "https://example.com",
        expect.objectContaining({ waitUntil: "networkidle2" }),
      );
    });

    it("should reject navigation to non-allowed domain", async () => {
      const restrictedTool = new BrowserTool(mockLogger, {
        allowedDomains: ["example.com"],
      });
      await restrictedTool.initialize();

      const result = await restrictedTool.execute(
        {
          operation: "navigate",
          params: { url: "https://malicious.com" },
        },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("not in allowed list");

      await restrictedTool.shutdown();
    });
  });

  describe("click", () => {
    it("should click element", async () => {
      const result = await tool.execute(
        {
          operation: "click",
          params: { selector: "#button" },
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.data.clicked).toBe(true);
      expect(mockPage.click).toHaveBeenCalledWith("#button");
    });

    it("should wait for navigation after click", async () => {
      mockPage.url = vi
        .fn()
        .mockReturnValueOnce("https://example.com")
        .mockReturnValueOnce("https://example.com/new");

      const result = await tool.execute(
        {
          operation: "click",
          params: { selector: "#link", waitForNavigation: true },
        },
        mockContext,
      );

      expect(result.data.navigated).toBe(true);
      expect(result.data.newUrl).toBe("https://example.com/new");
    });
  });

  describe("type", () => {
    it("should type text into field", async () => {
      const result = await tool.execute(
        {
          operation: "type",
          params: { selector: "#input", text: "Hello World" },
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.data.typed).toBe(true);
      expect(result.data.charactersTyped).toBe(11);
      expect(mockPage.type).toHaveBeenCalledWith("#input", "Hello World", {
        delay: 0,
      });
    });

    it("should clear field before typing", async () => {
      await tool.execute(
        {
          operation: "type",
          params: { selector: "#input", text: "New Text", clearFirst: true },
        },
        mockContext,
      );

      expect(mockPage.click).toHaveBeenCalledWith("#input", { clickCount: 3 });
      expect(mockPage.keyboard.press).toHaveBeenCalledWith("Backspace");
    });
  });

  describe("screenshot", () => {
    it("should take screenshot", async () => {
      const result = await tool.execute(
        {
          operation: "screenshot",
          params: { type: "png", fullPage: false },
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.data.data).toBeDefined();
      expect(result.data.format).toBe("png");
    });
  });

  describe("extract", () => {
    it("should extract text from element", async () => {
      const result = await tool.execute(
        {
          operation: "extract",
          params: { selector: ".content" },
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.data.value).toBe("extracted text");
      expect(result.data.count).toBe(1);
    });

    it("should extract from multiple elements", async () => {
      const result = await tool.execute(
        {
          operation: "extract",
          params: { selector: ".item", multiple: true },
        },
        mockContext,
      );

      expect(result.data.value).toEqual(["text1", "text2"]);
      expect(result.data.count).toBe(2);
    });
  });

  describe("evaluate", () => {
    it("should execute JavaScript in page context", async () => {
      const result = await tool.execute(
        {
          operation: "evaluate",
          params: { script: "return document.title" },
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(mockPage.evaluate).toHaveBeenCalled();
    });
  });

  describe("formFill", () => {
    it("should fill form fields", async () => {
      const result = await tool.execute(
        {
          operation: "formFill",
          params: {
            fields: [
              { selector: "#name", value: "John Doe", type: "text" },
              { selector: "#country", value: "US", type: "select" },
            ],
          },
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.data.fieldsFilled).toBe(2);
    });
  });

  describe("page management", () => {
    it("should create multiple pages", async () => {
      await tool.execute(
        {
          operation: "navigate",
          params: { url: "https://example.com" },
          pageId: "page1",
        },
        mockContext,
      );

      await tool.execute(
        {
          operation: "navigate",
          params: { url: "https://example.org" },
          pageId: "page2",
        },
        mockContext,
      );

      const pageIds = await tool.getPageIds();
      expect(pageIds).toHaveLength(2);
    });

    it("should enforce max pages limit", async () => {
      const limitedTool = new BrowserTool(mockLogger, { maxPages: 1 });
      await limitedTool.initialize();

      await limitedTool.execute(
        {
          operation: "navigate",
          params: { url: "https://example.com" },
          pageId: "page1",
        },
        mockContext,
      );

      const result = await limitedTool.execute(
        {
          operation: "navigate",
          params: { url: "https://example.org" },
          pageId: "page2",
        },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Maximum number of pages");

      await limitedTool.shutdown();
    });
  });
});
