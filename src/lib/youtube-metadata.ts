/**
 * YouTube Metadata Service
 * Fetches video metadata via YouTube oEmbed API and formats for Google Ads (PMax, Demand Gen, Video)
 * Port of the old lib/youtube-metadata.js (pure fetch — no changes needed for Workers).
 */

export class YouTubeMetadataService {
  /**
   * Extract YouTube Video ID (11 chars) from various URL formats
   * Examples:
   * - https://www.youtube.com/watch?v=dQw4w9WgXcQ
   * - https://youtu.be/dQw4w9WgXcQ
   * - https://www.youtube.com/shorts/dQw4w9WgXcQ
   * - https://www.youtube.com/embed/dQw4w9WgXcQ
   * - dQw4w9WgXcQ
   */
  static extractVideoId(input: unknown): string | null {
    if (!input || typeof input !== "string") return null;
    const cleanInput = input.trim();

    // Direct 11-char ID check
    if (/^[a-zA-Z0-9_-]{11}$/.test(cleanInput)) {
      return cleanInput;
    }

    const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?|shorts)\/|.*[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
    const match = cleanInput.match(regex);
    return match?.[1] ?? null;
  }

  static canonicalUrl(videoId: string): string {
    return `https://www.youtube.com/watch?v=${videoId}`;
  }

  /**
   * Smart Word-Boundary Slicing for Short Headline (Max 15 characters)
   * Slices at full word boundaries so words are never cut in half.
   */
  static smartTruncateShortHeadline(title: unknown, maxLength = 15): string {
    if (!title || typeof title !== "string") return "Watch Now";
    const clean = title.trim();
    if (clean.length <= maxLength) return clean;

    const words = clean.split(/\s+/);
    let accumulated = "";
    for (const word of words) {
      const candidate = accumulated ? `${accumulated} ${word}` : word;
      if (candidate.length <= maxLength) {
        accumulated = candidate;
      } else {
        break;
      }
    }

    if (accumulated && accumulated.length >= 2) {
      return accumulated;
    }

    return "Watch Now";
  }

  /**
   * Fetch video metadata via YouTube oEmbed API and auto-format for Google Video / PMax / Demand Gen
   */
  static async fetchMetadata(urlOrId: string) {
    const videoId = this.extractVideoId(urlOrId);
    if (!videoId) {
      throw new Error(`Invalid YouTube URL or Video ID: "${urlOrId}"`);
    }

    const canonicalUrl = this.canonicalUrl(videoId);
    const defaultThumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`;

      const response = await fetch(oembedUrl, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) {
        return this.formatFallback(videoId, canonicalUrl, defaultThumbnail);
      }

      const data: any = await response.json();
      const rawTitle = (data?.title || "Featured Video").trim();
      const authorName = (data?.author_name || "").trim();
      const thumbnailUrl = data?.thumbnail_url || defaultThumbnail;

      // Smart Truncations for Google Video Ads specs
      const longHeadline = rawTitle.length > 90 ? rawTitle.substring(0, 87) + "..." : rawTitle;
      const shortHeadline = this.smartTruncateShortHeadline(rawTitle, 15);
      const description = authorName
        ? `Watch ${rawTitle} by ${authorName}`.substring(0, 70)
        : rawTitle.substring(0, 70);

      return {
        youtubeVideoId: videoId,
        youtubeVideoUrl: canonicalUrl,
        title: rawTitle,
        authorName,
        thumbnailUrl,
        shortHeadline,
        longHeadline,
        description,
      };
    } catch {
      return this.formatFallback(videoId, canonicalUrl, defaultThumbnail);
    }
  }

  static formatFallback(videoId: string, canonicalUrl: string, thumbnailUrl: string) {
    return {
      youtubeVideoId: videoId,
      youtubeVideoUrl: canonicalUrl,
      title: `YouTube Video ${videoId}`,
      thumbnailUrl,
      shortHeadline: "Watch Now",
      longHeadline: `Watch YouTube Video ${videoId}`,
      description: "Check out our latest video content on YouTube.",
    };
  }
}
