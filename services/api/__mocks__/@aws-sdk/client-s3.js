// Manual mock for the S3 client. Records the commands sent so tests can assert
// which object a request actually touched without any network access.
const sent = [];

class PutObjectCommand {
  constructor(input) {
    this.input = input;
    this.name = 'PutObjectCommand';
  }
}

class DeleteObjectCommand {
  constructor(input) {
    this.input = input;
    this.name = 'DeleteObjectCommand';
  }
}

class S3Client {
  constructor(config) {
    this.config = config;
  }

  async send(command) {
    sent.push(command);
    return {};
  }
}

module.exports = {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  __sent: sent,
  __reset: () => sent.splice(0, sent.length),
};
