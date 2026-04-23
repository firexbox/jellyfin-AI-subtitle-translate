/**
 * Subtitle Parser Library
 * Supports SRT, ASS/SSA, VTT formats
 */

const SubtitleParser = {
  /**
   * Parse subtitle content based on format detection
   */
  parse(content, format) {
    if (!format) format = this.detectFormat(content);
    switch (format) {
      case 'srt': return this.parseSRT(content);
      case 'ass': case 'ssa': return this.parseASS(content);
      case 'vtt': return this.parseVTT(content);
      default: return this.parseSRT(content);
    }
  },

  detectFormat(content) {
    if (content.includes('WEBVTT')) return 'vtt';
    if (content.includes('[Script Info]')) return 'ass';
    if (content.includes('Dialogue:')) return 'ass';
    return 'srt';
  },

  /**
   * Parse SRT format
   */
  parseSRT(content) {
    const cues = [];
    const blocks = content.trim().split(/\n\s*\n/);
    const timeRegex = /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/;

    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length < 2) continue;

      const timeLine = lines.find(l => timeRegex.test(l));
      if (!timeLine) continue;

      const match = timeLine.match(timeRegex);
      const textLines = lines.slice(lines.indexOf(timeLine) + 1);
      const text = textLines.join('\n').replace(/<[^>]+>/g, '').trim();

      if (text) {
        cues.push({
          start: this.timeToMs(match[1]),
          end: this.timeToMs(match[2]),
          text: text,
          originalText: text
        });
      }
    }
    return cues;
  },

  /**
   * Parse ASS/SSA format
   */
  parseASS(content) {
    const cues = [];
    const eventSection = content.match(/\[Events\]([\s\S]*?)(?=\[|$)/);
    if (!eventSection) return cues;

    const lines = eventSection[1].trim().split('\n');
    const formatLine = lines.find(l => l.startsWith('Format:'));
    if (!formatLine) return cues;

    const fields = formatLine.replace('Format:', '').split(',').map(f => f.trim());
    const textIdx = fields.indexOf('Text');
    const startIdx = fields.indexOf('Start');
    const endIdx = fields.indexOf('End');

    if (textIdx === -1 || startIdx === -1 || endIdx === -1) return cues;

    for (const line of lines) {
      if (!line.startsWith('Dialogue:')) continue;
      const parts = line.replace('Dialogue:', '').split(',');
      if (parts.length <= Math.max(textIdx, startIdx, endIdx)) continue;

      const text = parts.slice(textIdx).join(',').replace(/\{[^}]*\}/g, '').replace(/\\N/g, '\n').trim();
      if (text) {
        cues.push({
          start: this.asTimeToMs(parts[startIdx].trim()),
          end: this.asTimeToMs(parts[endIdx].trim()),
          text: text,
          originalText: text
        });
      }
    }
    return cues;
  },

  /**
   * Parse WebVTT format
   */
  parseVTT(content) {
    const cues = [];
    const lines = content.replace('WEBVTT', '').trim().split('\n');
    const timeRegex = /(\d{2}:)?(\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:)?(\d{2}:\d{2}\.\d{3})/;
    let i = 0;

    while (i < lines.length) {
      const match = lines[i].match(timeRegex);
      if (match) {
        const start = match[1] ? match[1] + match[2] : '00:' + match[2];
        const end = match[3] ? match[3] + match[4] : '00:' + match[4];
        const textLines = [];
        i++;
        while (i < lines.length && lines[i].trim() !== '' && !timeRegex.test(lines[i])) {
          textLines.push(lines[i].replace(/<[^>]+>/g, ''));
          i++;
        }
        const text = textLines.join('\n').trim();
        if (text) {
          cues.push({
            start: this.timeToMs(start.replace('.', ',')),
            end: this.timeToMs(end.replace('.', ',')),
            text: text,
            originalText: text
          });
        }
      } else {
        i++;
      }
    }
    return cues;
  },

  timeToMs(timeStr) {
    const [hms, ms] = timeStr.replace('.', ',').split(',');
    const [h, m, s] = hms.split(':');
    return parseInt(h) * 3600000 + parseInt(m) * 60000 + parseInt(s) * 1000 + parseInt(ms || 0);
  },

  asTimeToMs(timeStr) {
    const parts = timeStr.split(':');
    if (parts.length === 3) {
      return parseInt(parts[0]) * 3600000 + parseInt(parts[1]) * 60000 + parseFloat(parts[2]) * 1000;
    }
    return 0;
  },

  /**
   * Convert cues back to SRT format
   */
  toSRT(cues) {
    return cues.map((cue, i) => {
      const num = i + 1;
      const start = this.msToSRTTime(cue.start);
      const end = this.msToSRTTime(cue.end);
      return `${num}\n${start} --> ${end}\n${cue.translatedText || cue.text}\n`;
    }).join('\n');
  },

  msToSRTTime(ms) {
    const h = Math.floor(ms / 3600000).toString().padStart(2, '0');
    const m = Math.floor((ms % 3600000) / 60000).toString().padStart(2, '0');
    const s = Math.floor((ms % 60000) / 1000).toString().padStart(2, '0');
    const mls = Math.floor(ms % 1000).toString().padStart(3, '0');
    return `${h}:${m}:${s},${mls}`;
  }
};

// Expose for module usage
if (typeof window !== 'undefined') {
  window.SubtitleParser = SubtitleParser;
}
