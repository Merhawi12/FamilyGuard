const KEYWORDS = [
  // Threats & violence
  'kill yourself', 'kys', 'i will kill you', 'i hate you', 'die',
  'go die', 'kill u', 'hurt yourself', 'cut yourself',
  // Harassment
  'loser', 'ugly', 'fat', 'stupid', 'idiot', 'moron', 'retard', 'freak',
  'nobody likes you', 'no one likes you', 'you are worthless', 'worthless',
  // Slurs (abbreviated — real list should be expanded)
  'faggot', 'nigger', 'bitch', 'whore', 'slut',
  // Grooming / predator signals
  'send me a picture', 'send pics', 'send nudes', 'are you alone',
  'dont tell your parents', 'keep this secret', 'our little secret',
  'how old are you', 'meet me', 'meet up', 'come over',
  // Extortion / blackmail
  'i will share', 'i will post', 'i will tell everyone', 'pay me',
];

/**
 * Checks a text message for cyberbullying / predator keywords.
 * Returns { detected: boolean, matchedKeywords: string[] }
 */
const detectCyberbullying = (text) => {
  if (!text || typeof text !== 'string') return { detected: false, matchedKeywords: [] };

  const lower = text.toLowerCase();
  const matchedKeywords = KEYWORDS.filter((kw) => lower.includes(kw));

  return {
    detected: matchedKeywords.length > 0,
    matchedKeywords,
  };
};

module.exports = { detectCyberbullying };
