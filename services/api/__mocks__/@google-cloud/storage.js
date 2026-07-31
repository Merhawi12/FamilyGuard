// Manual mock for the Cloud Storage client. Auto-applied (adjacent to
// node_modules), so no test needs to call jest.mock. Records every operation so
// tests can assert which object a request actually touched, with no network
// access and no credentials — real V4 signing would need a private key.
const sent = [];

class File {
  constructor(bucketName, name) {
    this.bucketName = bucketName;
    this.name = name;
  }

  /** Mirrors the real signature: resolves to a single-element array. */
  async getSignedUrl(options = {}) {
    sent.push({ op: 'getSignedUrl', bucket: this.bucketName, key: this.name, options });
    const expires = Number(options.expires) || 0;
    return [
      `https://storage.googleapis.com/${this.bucketName}/${this.name}` +
        `?X-Goog-Expires=${expires}&X-Goog-SignedHeaders=host&X-Goog-Signature=test`,
    ];
  }

  async delete(options = {}) {
    sent.push({ op: 'delete', bucket: this.bucketName, key: this.name, options });
    return [{}];
  }
}

class Bucket {
  constructor(name) {
    this.name = name;
  }

  file(name) {
    return new File(this.name, name);
  }
}

class Storage {
  constructor(config) {
    this.config = config;
  }

  bucket(name) {
    return new Bucket(name);
  }
}

module.exports = {
  Storage,
  __sent: sent,
  __reset: () => sent.splice(0, sent.length),
};
