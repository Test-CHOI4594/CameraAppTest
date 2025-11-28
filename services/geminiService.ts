import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

/**
 * Analyzes a base64 image string to describe movement or security concerns.
 */
export const analyzeSecuritySnapshot = async (base64Image: string): Promise<string> => {
  try {
    // Strip the data:image/jpeg;base64, prefix if present
    const cleanBase64 = base64Image.split(',')[1] || base64Image;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: 'image/jpeg',
              data: cleanBase64
            }
          },
          {
            text: "You are a security AI. Briefly describe what is happening in this security camera frame in one short sentence. Focus on movement or people."
          }
        ]
      }
    });

    return response.text?.trim() || "Activity detected.";
  } catch (error) {
    console.error("Gemini analysis error:", error);
    return "Analysis failed due to network or API error.";
  }
};