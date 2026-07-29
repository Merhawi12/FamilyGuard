// Returns a deterministic stand-in for a pre-signed URL so tests can assert the
// key that was signed without needing credentials.
const getSignedUrl = jest.fn(async (_client, command, options) => {
  const { Bucket, Key } = command.input;
  return `https://${Bucket}.s3.amazonaws.com/${Key}?X-Amz-Expires=${options?.expiresIn ?? 0}&X-Amz-Signature=test`;
});

module.exports = { getSignedUrl };
