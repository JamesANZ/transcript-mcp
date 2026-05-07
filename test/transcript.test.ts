/**
 * Unit tests for transcript MCP server components
 */

import {
  detectPlatform,
  extractVideoInfo,
  validateUrl,
} from "../src/url-detector.js";
import { TranscriptParser } from "../src/parser.js";
import { InvalidUrlError } from "../src/errors.js";

describe("URL Detector", () => {
  describe("detectPlatform", () => {
    it("should detect YouTube URLs", () => {
      expect(
        detectPlatform("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
      ).toBe("youtube");
      expect(detectPlatform("https://youtu.be/dQw4w9WgXcQ")).toBe("youtube");
      expect(detectPlatform("https://m.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
        "youtube",
      );
      expect(detectPlatform("dQw4w9WgXcQ")).toBe("youtube"); // Direct video ID
    });

    it("should detect Bilibili URLs", () => {
      expect(
        detectPlatform("https://www.bilibili.com/video/BV1xx411c7mu"),
      ).toBe("bilibili");
      expect(detectPlatform("https://b23.tv/xxxxx")).toBe("bilibili");
    });

    it("should detect Vimeo URLs", () => {
      expect(detectPlatform("https://vimeo.com/123456789")).toBe("vimeo");
      expect(detectPlatform("https://vimeo.com/channels/xxxxx/123456789")).toBe(
        "vimeo",
      );
    });

    it("should return unknown for unsupported but valid URLs", () => {
      expect(detectPlatform("https://example.com/video")).toBe("unknown");
    });

    it("should throw for invalid URLs", () => {
      expect(() => detectPlatform("not-a-url")).toThrow(InvalidUrlError);
    });
  });

  describe("extractVideoInfo", () => {
    it("should extract YouTube video ID", () => {
      const info = extractVideoInfo(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      );
      expect(info.platform).toBe("youtube");
      expect(info.videoId).toBe("dQw4w9WgXcQ");
    });

    it("should extract Bilibili video ID", () => {
      const info = extractVideoInfo(
        "https://www.bilibili.com/video/BV1xx411c7mu",
      );
      expect(info.platform).toBe("bilibili");
      expect(info.videoId).toBe("BV1xx411c7mu");
    });

    it("should extract Vimeo video ID", () => {
      const info = extractVideoInfo("https://vimeo.com/123456789");
      expect(info.platform).toBe("vimeo");
      expect(info.videoId).toBe("123456789");
    });
  });

  describe("validateUrl", () => {
    it("should not throw for valid URLs", () => {
      expect(() =>
        validateUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
      ).not.toThrow();
      expect(() =>
        validateUrl("https://www.bilibili.com/video/BV1xx411c7mu"),
      ).not.toThrow();
    });

    it("should throw for invalid URLs", () => {
      expect(() => validateUrl("not-a-url")).toThrow(InvalidUrlError);
    });
  });
});

describe("Transcript Parser", () => {
  const parser = new TranscriptParser();

  describe("detectFormat", () => {
    it("should detect SRT format", () => {
      const srt = "1\n00:00:00,000 --> 00:00:05,000\nHello world\n\n";
      expect(parser.detectFormat(srt)).toBe("srt");
    });

    it("should detect VTT format", () => {
      const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nHello world\n";
      expect(parser.detectFormat(vtt)).toBe("vtt");
    });

    it("should detect JSON format", () => {
      const json = '{"body": [{"from": 0, "to": 5, "content": "Hello"}]}';
      expect(parser.detectFormat(json)).toBe("json");
    });
  });

  describe("parse SRT", () => {
    it("should parse simple SRT content", () => {
      const srt = `1
00:00:00,000 --> 00:00:05,000
Hello world

2
00:00:05,000 --> 00:00:10,000
This is a test
`;

      const result = parser.parse(srt, "https://example.com/video");
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        text: "Hello world",
        start: 0,
        duration: 5,
      });
      expect(result[1]).toEqual({
        text: "This is a test",
        start: 5,
        duration: 5,
      });
    });

    it("should handle SRT with periods as separators", () => {
      const srt = `1
00:00:00.000 --> 00:00:05.000
Hello world
`;

      const result = parser.parse(srt, "https://example.com/video");
      expect(result).toHaveLength(1);
      expect(result[0].start).toBe(0);
      expect(result[0].duration).toBe(5);
    });

    it("should handle multi-line SRT entries", () => {
      const srt = `1
00:00:00,000 --> 00:00:05,000
Line one
Line two
Line three
`;

      const result = parser.parse(srt, "https://example.com/video");
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe("Line one Line two Line three");
    });
  });

  describe("parse VTT", () => {
    it("should parse simple VTT content", () => {
      const vtt = `WEBVTT

00:00:00.000 --> 00:00:05.000
Hello world

00:00:05.000 --> 00:00:10.000
This is a test
`;

      const result = parser.parse(vtt, "https://example.com/video");
      expect(result).toHaveLength(2);
      expect(result[0].text).toBe("Hello world");
      expect(result[1].text).toBe("This is a test");
    });
  });

  describe("parse JSON", () => {
    it("should parse Bilibili-style JSON", () => {
      const json = JSON.stringify({
        body: [
          { from: 0, to: 5, content: "Hello" },
          { from: 5, to: 10, content: "World" },
        ],
      });

      const result = parser.parse(json, "https://example.com/video");
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        text: "Hello",
        start: 0,
        duration: 5,
      });
    });

    it("should parse array-style JSON", () => {
      const json = JSON.stringify([
        { start: 0, end: 5, text: "Hello" },
        { start: 5, end: 10, text: "World" },
      ]);

      const result = parser.parse(json, "https://example.com/video");
      expect(result).toHaveLength(2);
      expect(result[0].text).toBe("Hello");
    });
  });

  describe("error handling", () => {
    it("should return an empty list when no cues can be parsed", () => {
      const result = parser.parse(
        "invalid content that doesn't match any format",
        "https://example.com/video",
      );
      expect(result).toEqual([]);
    });
  });

  describe("text cleaning", () => {
    it("should remove HTML tags", () => {
      const srt = `1
00:00:00,000 --> 00:00:05,000
Hello <b>world</b> with <i>formatting</i>
`;

      const result = parser.parse(srt, "https://example.com/video");
      expect(result[0].text).toBe("Hello world with formatting");
    });

    it("should decode HTML entities", () => {
      const srt = `1
00:00:00,000 --> 00:00:05,000
Hello &amp; world &quot;test&quot;
`;

      const result = parser.parse(srt, "https://example.com/video");
      expect(result[0].text).toBe('Hello & world "test"');
    });
  });
});
